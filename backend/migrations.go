package main

import (
	"encoding/json"
	"fmt"

	"github.com/google/uuid"
	"github.com/pocketbase/pocketbase/core"
	m "github.com/pocketbase/pocketbase/migrations"
)

func productionRateLimitRules() []core.RateLimitRule {
	all := core.RateLimitRuleAudienceAll
	return []core.RateLimitRule{
		{Label: "*:auth", Audience: all, MaxRequests: 120, Duration: 60},
		{Label: "POST /api/oauth/register", Audience: all, MaxRequests: 30, Duration: 3600},
		{Label: "GET /api/oauth/authorize", Audience: all, MaxRequests: 120, Duration: 600},
		{Label: "GET /api/oauth/consent", Audience: all, MaxRequests: 120, Duration: 600},
		{Label: "POST /api/oauth/consent", Audience: all, MaxRequests: 120, Duration: 600},
		{Label: "POST /api/oauth/token", Audience: all, MaxRequests: 120, Duration: 60},
		{Label: "POST /api/oauth/revoke", Audience: all, MaxRequests: 60, Duration: 60},
		{Label: "GET /api/oauth/connections", Audience: all, MaxRequests: 120, Duration: 60},
		{Label: "POST /api/oauth/connections/", Audience: all, MaxRequests: 120, Duration: 60},
		{Label: "POST /api/todo/mcp", Audience: all, MaxRequests: 600, Duration: 60},
		{Label: "GET /api/todo/mcp", Audience: all, MaxRequests: 600, Duration: 60},
		{Label: "DELETE /api/todo/mcp", Audience: all, MaxRequests: 600, Duration: 60},
		{Label: "POST /api/todo/push", Audience: all, MaxRequests: 600, Duration: 60},
		{Label: "GET /api/todo/pull", Audience: all, MaxRequests: 6000, Duration: 60},
		{Label: "GET /api/todo/snapshot", Audience: all, MaxRequests: 6000, Duration: 60},
		{Label: "GET /api/realtime", Audience: all, MaxRequests: 1200, Duration: 60},
		{Label: "POST /api/realtime", Audience: all, MaxRequests: 1200, Duration: 60},
	}
}

func saveProductionRateLimits(app core.App) error {
	settings := app.Settings()
	settings.RateLimits.Enabled = true
	desired := productionRateLimitRules()
	managedLabels := make(map[string]struct{}, len(desired))
	for _, rule := range desired {
		managedLabels[rule.Label] = struct{}{}
	}
	kept := settings.RateLimits.Rules[:0]
	for _, rule := range settings.RateLimits.Rules {
		if _, managed := managedLabels[rule.Label]; !managed {
			kept = append(kept, rule)
		}
	}
	settings.RateLimits.Rules = append(kept, desired...)
	return app.Save(settings)
}

func init() {
	// Keep the original migration name so existing installations retain their collections and data.
	m.Register(func(app core.App) error {
		users := core.NewAuthCollection("todo_users")
		ownUser := "id = @request.auth.id"
		users.ListRule = &ownUser
		users.ViewRule = &ownUser
		users.UpdateRule = &ownUser
		users.PasswordAuth.Enabled = true
		users.PasswordAuth.IdentityFields = []string{"email"}
		if err := app.Save(users); err != nil {
			return err
		}
		owner := map[string]any{
			"name":         "owner",
			"type":         "relation",
			"required":     true,
			"collectionId": users.Id,
			"maxSelect":    1,
		}
		own := "@request.auth.id != \"\" && owner = @request.auth.id"
		field := func(name, kind string) map[string]any {
			return map[string]any{"name": name, "type": kind, "required": true}
		}
		text := func(name string, max int) map[string]any {
			v := field(name, "text")
			v["max"] = max
			return v
		}
		data := func(name string, max int) map[string]any {
			v := field(name, "json")
			v["maxSize"] = max
			return v
		}
		number := func(name string) map[string]any {
			v := field(name, "number")
			v["onlyInt"] = true
			v["min"] = 1
			return v
		}
		save := func(name string, fields []any, indexes []string, read bool) error {
			c := core.NewBaseCollection(name)
			schema := map[string]any{"fields": fields, "indexes": indexes}
			if read {
				schema["listRule"] = own
				schema["viewRule"] = own
			}
			b, _ := json.Marshal(schema)
			if err := json.Unmarshal(b, c); err != nil {
				return err
			}
			return app.Save(c)
		}
		for _, name := range []string{"tasks", "lists"} {
			if err := save(
				name,
				[]any{
					owner,
					text("entityId", 36),
					data("data", 65536),
					number("revision"),
					text("deviceId", 36),
					number("clientVersion"),
				},
				[]string{"CREATE UNIQUE INDEX idx_" + name + "_owner_entity ON " + name + " (owner, entityId)"},
				true,
			); err != nil {
				return err
			}
		}
		kind := field("kind", "select")
		kind["values"] = []string{"task", "list"}
		kind["maxSelect"] = 1
		if err := save(
			"todo_changes",
			[]any{owner, kind, text("entityId", 36), number("revision"), data("data", 65536)},
			[]string{
				"CREATE UNIQUE INDEX idx_changes_revision ON todo_changes (revision)",
				"CREATE INDEX idx_changes_owner_revision ON todo_changes (owner, revision)",
			},
			true,
		); err != nil {
			return err
		}
		if err := save(
			"todo_receipts",
			[]any{owner, text("mutationId", 36), text("request", 65536), data("ack", 4096)},
			[]string{"CREATE UNIQUE INDEX idx_receipts_owner_mutation ON todo_receipts (owner, mutationId)"},
			false,
		); err != nil {
			return err
		}
		_, err := app.DB().
			NewQuery("CREATE TABLE _todo_clock (id INTEGER PRIMARY KEY CHECK (id = 1), value INTEGER NOT NULL); INSERT INTO _todo_clock VALUES (1,0)").
			Execute()
		return err
	}, nil, "1789551000_todo.js")
	m.Register(func(app core.App) error {
		for _, sql := range []string{
			`CREATE TABLE _oauth_clients (id TEXT PRIMARY KEY, data TEXT NOT NULL, created INTEGER NOT NULL)`,
			`CREATE TABLE _oauth_pending (id TEXT PRIMARY KEY, data TEXT NOT NULL, expires INTEGER NOT NULL)`,
			`CREATE TABLE _oauth_tokens (hash TEXT PRIMARY KEY, kind TEXT NOT NULL, family TEXT NOT NULL, owner TEXT NOT NULL, data TEXT NOT NULL, spent INTEGER NOT NULL DEFAULT 0, expires INTEGER NOT NULL)`,
			`CREATE INDEX oauth_family ON _oauth_tokens(family)`,
		} {
			if _, err := app.DB().NewQuery(sql).Execute(); err != nil {
				return err
			}
		}
		return nil
	}, nil, "1789552000_oauth.go")
	m.Register(func(app core.App) error {
		return saveProductionRateLimits(app)
	}, nil, "1789553000_production_rate_limits.go")
	m.Register(func(app core.App) error {
		for _, sql := range []string{
			`CREATE TABLE _todo_sync_state (id INTEGER PRIMARY KEY CHECK (id = 1), generation TEXT NOT NULL)`,
			`INSERT INTO _todo_sync_state (id, generation) VALUES (1, '` + uuid.NewString() + `')`,
			`CREATE TABLE _todo_restore_runs (restore_id TEXT PRIMARY KEY, finalized INTEGER NOT NULL)`,
		} {
			if _, err := app.DB().NewQuery(sql).Execute(); err != nil {
				return err
			}
		}
		return nil
	}, nil, "1789554000_sync_generation.go")
	// Repair installations that already ran the original guest-only custom-route
	// rules. PocketBase authenticates before its global limiter, so those rules
	// did not apply to requests carrying a valid PocketBase auth token.
	m.Register(saveProductionRateLimits, nil, "1789555000_authenticated_rate_limits.go")
	m.Register(func(app core.App) error {
		// Add reference columns without rebuilding or discarding either table. The
		// migration is transactional and fails closed if an existing grant cannot
		// be linked back to its registered client.
		for _, sql := range []string{
			`ALTER TABLE _oauth_clients ADD COLUMN last_used INTEGER NOT NULL DEFAULT 0`,
			`UPDATE _oauth_clients SET last_used = created`,
			`CREATE INDEX oauth_clients_last_used ON _oauth_clients(last_used)`,
			`ALTER TABLE _oauth_pending ADD COLUMN client_id TEXT REFERENCES _oauth_clients(id) ON DELETE RESTRICT`,
			`UPDATE _oauth_pending SET client_id = json_extract(data, '$.client_id[0]')`,
			`CREATE INDEX oauth_pending_client ON _oauth_pending(client_id)`,
			`ALTER TABLE _oauth_tokens ADD COLUMN client_id TEXT REFERENCES _oauth_clients(id) ON DELETE RESTRICT`,
			`UPDATE _oauth_tokens SET client_id = json_extract(data, '$.ClientID')`,
			`CREATE INDEX oauth_tokens_client ON _oauth_tokens(client_id)`,
		} {
			if _, err := app.DB().NewQuery(sql).Execute(); err != nil {
				return err
			}
		}

		var missing struct {
			Count int `db:"count"`
		}
		if err := app.DB().NewQuery(`
			SELECT
				(SELECT COUNT(*) FROM _oauth_pending WHERE client_id IS NULL OR client_id = '') +
				(SELECT COUNT(*) FROM _oauth_tokens WHERE client_id IS NULL OR client_id = '') count
		`).One(&missing); err != nil {
			return err
		}
		if missing.Count != 0 {
			return fmt.Errorf("cannot link %d existing OAuth grant rows to clients", missing.Count)
		}

		// SQLite permits NULL in an added reference column. These triggers make the
		// additive schema equivalent to NOT NULL for every future write while the
		// foreign keys prevent deleting referenced clients.
		for _, sql := range []string{
			`CREATE TRIGGER oauth_pending_client_required_insert
				BEFORE INSERT ON _oauth_pending
				WHEN NEW.client_id IS NULL OR NEW.client_id = ''
				BEGIN SELECT RAISE(ABORT, 'OAuth pending client_id is required'); END`,
			`CREATE TRIGGER oauth_pending_client_required_update
				BEFORE UPDATE OF client_id ON _oauth_pending
				WHEN NEW.client_id IS NULL OR NEW.client_id = ''
				BEGIN SELECT RAISE(ABORT, 'OAuth pending client_id is required'); END`,
			`CREATE TRIGGER oauth_tokens_client_required_insert
				BEFORE INSERT ON _oauth_tokens
				WHEN NEW.client_id IS NULL OR NEW.client_id = ''
				BEGIN SELECT RAISE(ABORT, 'OAuth token client_id is required'); END`,
			`CREATE TRIGGER oauth_tokens_client_required_update
				BEFORE UPDATE OF client_id ON _oauth_tokens
				WHEN NEW.client_id IS NULL OR NEW.client_id = ''
				BEGIN SELECT RAISE(ABORT, 'OAuth token client_id is required'); END`,
		} {
			if _, err := app.DB().NewQuery(sql).Execute(); err != nil {
				return err
			}
		}
		return nil
	}, nil, "1789556000_oauth_client_retention.go")
	m.Register(func(app core.App) error {
		for _, sql := range []string{
			`CREATE TABLE _oauth_refresh_replays (
				hash TEXT PRIMARY KEY,
				family TEXT NOT NULL,
				expires INTEGER NOT NULL,
				spent_at INTEGER NOT NULL
			)`,
			`CREATE INDEX oauth_refresh_replays_family ON _oauth_refresh_replays(family)`,
			`CREATE INDEX oauth_refresh_replays_expires ON _oauth_refresh_replays(expires)`,
			`INSERT INTO _oauth_refresh_replays(hash,family,expires,spent_at)
				SELECT hash,family,expires,CAST(strftime('%s','now') AS INTEGER)
				FROM _oauth_tokens WHERE kind='refresh' AND spent != 0`,
			`DELETE FROM _oauth_tokens WHERE kind='refresh' AND spent != 0`,
			`DELETE FROM _oauth_tokens WHERE kind='access' AND spent != 0`,
		} {
			if _, err := app.DB().NewQuery(sql).Execute(); err != nil {
				return err
			}
		}
		return nil
	}, nil, "1789557000_oauth_refresh_compaction.go")
}
