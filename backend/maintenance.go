package main

import (
	"log/slog"
	"time"

	"github.com/pocketbase/dbx"
	"github.com/pocketbase/pocketbase/core"
)

const oauthCleanupJobID = "freiraumOAuthCleanup"

type oauthCleanupStats struct {
	Pending       int64
	TokenFamilies int64
	Tokens        int64
}

// cleanupOAuth removes only records that cannot participate in a valid grant.
// In particular, spent refresh tokens of an active family are retained because
// their replay must continue to revoke the rest of that family.
func cleanupOAuth(app core.App, now time.Time) (oauthCleanupStats, error) {
	stats := oauthCleanupStats{}
	err := app.RunInTransaction(func(tx core.App) error {
		result, err := tx.DB().
			NewQuery("DELETE FROM _oauth_pending WHERE expires <= {:now}").
			Bind(dbx.Params{"now": now.Unix()}).
			Execute()
		if err != nil {
			return err
		}
		stats.Pending, err = result.RowsAffected()
		if err != nil {
			return err
		}

		var families []struct {
			Family string `db:"family"`
		}
		err = tx.DB().
			NewQuery(`
				SELECT family
				FROM _oauth_tokens
				GROUP BY family
				HAVING SUM(CASE WHEN spent = 0 AND expires > {:now} THEN 1 ELSE 0 END) = 0
			`).
			Bind(dbx.Params{"now": now.Unix()}).
			All(&families)
		if err != nil {
			return err
		}

		for _, family := range families {
			result, err = tx.DB().
				NewQuery("DELETE FROM _oauth_tokens WHERE family = {:family}").
				Bind(dbx.Params{"family": family.Family}).
				Execute()
			if err != nil {
				return err
			}
			deleted, err := result.RowsAffected()
			if err != nil {
				return err
			}
			stats.TokenFamilies++
			stats.Tokens += deleted
		}

		return nil
	})
	if err != nil {
		return oauthCleanupStats{}, err
	}
	return stats, nil
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
		)
	})
}
