package main

import (
	"errors"
	"log/slog"
	"time"

	"github.com/pocketbase/dbx"
	"github.com/pocketbase/pocketbase/core"
)

const oauthCleanupJobID = "freiraumOAuthCleanup"

const (
	// Public dynamic registration has no authenticated principal that could own a
	// quota. Keep a process-independent database ceiling in addition to the
	// per-IP rate limit so distributed registrations cannot grow storage without
	// bound. 4096 registrations are ample for a single-instance installation
	// while bounding worst-case client metadata to a few dozen MiB.
	oauthClientLimit = 4096

	// A public client can always register again. Preserve it for a full refresh
	// token lifetime after its last successful grant, and never remove it while a
	// token family still references it.
	oauthClientIdleTTL = 30 * 24 * time.Hour
)

var errOAuthClientCapacity = errors.New("OAuth client registration capacity reached")

type oauthCleanupStats struct {
	Pending        int64
	TokenFamilies  int64
	Tokens         int64
	RefreshReplays int64
	Clients        int64
}

// cleanupStaleOAuthClients treats an unauthenticated pending request as
// disposable once its client has been idle for the full TTL. Deleting pending
// rows and clients in the same transaction prevents public /authorize traffic
// from keeping otherwise unused registrations alive forever. Any token row,
// including replay-relevant evidence still in the token table, protects the
// client and the foreign keys remain the final race-safety guard.
func cleanupStaleOAuthClients(app core.App, now time.Time) (clients, pending int64, err error) {
	params := dbx.Params{"cutoff": now.Add(-oauthClientIdleTTL).Unix()}
	result, err := app.DB().NewQuery(`
		DELETE FROM _oauth_pending
		WHERE client_id IN (
			SELECT id FROM _oauth_clients
			WHERE last_used <= {:cutoff}
				AND NOT EXISTS (
					SELECT 1 FROM _oauth_tokens
					WHERE _oauth_tokens.client_id = _oauth_clients.id
				)
		)
	`).Bind(params).Execute()
	if err != nil {
		return 0, 0, err
	}
	pending, err = result.RowsAffected()
	if err != nil {
		return 0, 0, err
	}
	result, err = app.DB().NewQuery(`
		DELETE FROM _oauth_clients
		WHERE last_used <= {:cutoff}
			AND NOT EXISTS (
				SELECT 1 FROM _oauth_pending
				WHERE _oauth_pending.client_id = _oauth_clients.id
			)
			AND NOT EXISTS (
				SELECT 1 FROM _oauth_tokens
				WHERE _oauth_tokens.client_id = _oauth_clients.id
			)
	`).Bind(params).Execute()
	if err != nil {
		return 0, 0, err
	}
	clients, err = result.RowsAffected()
	return clients, pending, err
}

// reclaimOldestOAuthClient is the emergency admission path at the hard cap.
// It evicts exactly one oldest tokenless registration. A pending authorization
// is not an authenticated grant and is removed atomically with the client;
// concurrent consent either commits its code first (and therefore protects the
// client) or observes the request as expired.
func reclaimOldestOAuthClient(app core.App) (bool, error) {
	var rows []struct {
		ID string `db:"id"`
	}
	if err := app.DB().NewQuery(`
		SELECT id FROM _oauth_clients
		WHERE NOT EXISTS (
			SELECT 1 FROM _oauth_tokens
			WHERE _oauth_tokens.client_id = _oauth_clients.id
		)
		ORDER BY last_used ASC, created ASC, id ASC
		LIMIT 1
	`).All(&rows); err != nil {
		return false, err
	}
	if len(rows) == 0 {
		return false, nil
	}
	if _, err := app.DB().NewQuery("DELETE FROM _oauth_pending WHERE client_id={:id}").
		Bind(dbx.Params{"id": rows[0].ID}).Execute(); err != nil {
		return false, err
	}
	result, err := app.DB().NewQuery("DELETE FROM _oauth_clients WHERE id={:id}").
		Bind(dbx.Params{"id": rows[0].ID}).Execute()
	if err != nil {
		return false, err
	}
	deleted, err := result.RowsAffected()
	return deleted == 1, err
}

// cleanupOAuth removes only records that cannot participate in a valid grant.
// Spent refresh hashes for active families remain in the compact replay table
// until their original absolute expiry.
func cleanupOAuthTx(app core.App, now time.Time) (oauthCleanupStats, error) {
	stats := oauthCleanupStats{}
	result, err := app.DB().
		NewQuery("DELETE FROM _oauth_pending WHERE expires <= {:now}").
		Bind(dbx.Params{"now": now.Unix()}).
		Execute()
	if err != nil {
		return oauthCleanupStats{}, err
	}
	stats.Pending, err = result.RowsAffected()
	if err != nil {
		return oauthCleanupStats{}, err
	}

	var families []struct {
		Family string `db:"family"`
	}
	err = app.DB().
		NewQuery(`
				SELECT family
				FROM _oauth_tokens
				GROUP BY family
				HAVING SUM(CASE WHEN spent = 0 AND expires > {:now} THEN 1 ELSE 0 END) = 0
			`).
		Bind(dbx.Params{"now": now.Unix()}).
		All(&families)
	if err != nil {
		return oauthCleanupStats{}, err
	}

	for _, family := range families {
		result, err = app.DB().
			NewQuery("DELETE FROM _oauth_tokens WHERE family = {:family}").
			Bind(dbx.Params{"family": family.Family}).
			Execute()
		if err != nil {
			return oauthCleanupStats{}, err
		}
		deleted, err := result.RowsAffected()
		if err != nil {
			return oauthCleanupStats{}, err
		}
		stats.TokenFamilies++
		stats.Tokens += deleted
	}

	result, err = app.DB().NewQuery(`
		DELETE FROM _oauth_refresh_replays
		WHERE expires <= {:now}
			OR NOT EXISTS (
				SELECT 1 FROM _oauth_tokens
				WHERE _oauth_tokens.family = _oauth_refresh_replays.family
			)
	`).Bind(dbx.Params{"now": now.Unix()}).Execute()
	if err != nil {
		return oauthCleanupStats{}, err
	}
	stats.RefreshReplays, err = result.RowsAffected()
	if err != nil {
		return oauthCleanupStats{}, err
	}

	var prunedPending int64
	stats.Clients, prunedPending, err = cleanupStaleOAuthClients(app, now)
	if err != nil {
		return oauthCleanupStats{}, err
	}
	stats.Pending += prunedPending

	return stats, nil
}

func cleanupOAuth(app core.App, now time.Time) (oauthCleanupStats, error) {
	var stats oauthCleanupStats
	err := app.RunInTransaction(func(tx core.App) error {
		var err error
		stats, err = cleanupOAuthTx(tx, now)
		return err
	})
	if err != nil {
		return oauthCleanupStats{}, err
	}
	return stats, nil
}

// createOAuthClient makes the capacity check and insert one serialized SQLite
// transaction. PocketBase's nonconcurrent transaction connection prevents two
// app requests from both observing the same final free slot.
func createOAuthClient(app core.App, client oauthClient, now time.Time, limit int) error {
	return app.RunInTransaction(func(tx core.App) error {
		var row struct {
			Count int `db:"count"`
		}
		if err := tx.DB().NewQuery("SELECT COUNT(*) count FROM _oauth_clients").One(&row); err != nil {
			return err
		}
		if row.Count >= limit {
			// The emergency path removes at most one tokenless registration and its
			// unauthenticated pending requests. Full family cleanup stays on cron.
			if _, err := reclaimOldestOAuthClient(tx); err != nil {
				return err
			}
			if err := tx.DB().NewQuery("SELECT COUNT(*) count FROM _oauth_clients").One(&row); err != nil {
				return err
			}
		}
		if row.Count >= limit {
			return errOAuthClientCapacity
		}

		_, err := tx.DB().NewQuery(`
			INSERT INTO _oauth_clients(id,data,created,last_used)
			VALUES ({:id},{:data},{:created},{:lastUsed})
		`).Bind(dbx.Params{
			"id": client.ID, "data": canonical(client),
			"created": now.Unix(), "lastUsed": now.Unix(),
		}).Execute()
		return err
	})
}

func registerMaintenance(app core.App) error {
	return app.Cron().Add(oauthCleanupJobID, "23 3 * * *", func() {
		stats, err := cleanupOAuth(app, time.Now())
		if err != nil {
			app.Logger().Error("OAuth cleanup failed", slog.String("error", err.Error()))
			return
		}
		app.Logger().Info(
			"OAuth cleanup completed",
			slog.Int64("pending", stats.Pending),
			slog.Int64("tokenFamilies", stats.TokenFamilies),
			slog.Int64("tokens", stats.Tokens),
			slog.Int64("refreshReplays", stats.RefreshReplays),
			slog.Int64("clients", stats.Clients),
		)
	})
}
