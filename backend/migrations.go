package main

import (
	"encoding/json"

	"github.com/pocketbase/pocketbase/core"
	m "github.com/pocketbase/pocketbase/migrations"
)

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
}
