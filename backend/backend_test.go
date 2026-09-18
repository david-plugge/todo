package main

import (
	"archive/zip"
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"net/url"
	"os"
	"os/exec"
	"path/filepath"
	"reflect"
	"strings"
	"testing"
	"time"

	"github.com/go-oauth2/oauth2/v4/models"
	"github.com/google/uuid"
	"github.com/pocketbase/dbx"
	"github.com/pocketbase/pocketbase"
	"github.com/pocketbase/pocketbase/core"
)

func TestSyncGenerationAndHistoricalSnapshot(t *testing.T) {
	app := openTestApp(t, t.TempDir())
	generation, err := syncGeneration(app)
	if err != nil || uuid.Validate(generation) != nil {
		t.Fatalf("invalid sync generation %q: %v", generation, err)
	}
	users, err := app.FindCollectionByNameOrId("todo_users")
	if err != nil {
		t.Fatal(err)
	}
	user := core.NewRecord(users)
	user.SetEmail("snapshot@example.com")
	user.SetPassword("long-test-password")
	if err := app.Save(user); err != nil {
		t.Fatal(err)
	}
	changes, err := app.FindCollectionByNameOrId("todo_changes")
	if err != nil {
		t.Fatal(err)
	}
	first := "00000000-0000-4000-8000-000000000001"
	second := "00000000-0000-4000-8000-000000000002"
	insert := func(entityID string, revision int, title string) {
		t.Helper()
		record := core.NewRecord(changes)
		record.Load(Object{
			"owner": user.Id, "kind": "task", "entityId": entityID, "revision": revision,
			"data": Object{"id": entityID, "ownerId": user.Id, "title": title, "remoteRevision": revision},
		})
		if err := app.Save(record); err != nil {
			t.Fatal(err)
		}
	}
	insert(first, 1, "before cutoff")
	insert(second, 2, "second")
	insert(first, 3, "after cutoff")
	records, cursor, more, err := snapshotRecords(app, user.Id, "task", "", 2, 1)
	if err != nil {
		t.Fatal(err)
	}
	if len(records) != 1 || records[0]["title"] != "before cutoff" || cursor != first || !more {
		t.Fatalf("unexpected first snapshot page: records=%v cursor=%q more=%v", records, cursor, more)
	}
	records, cursor, more, err = snapshotRecords(app, user.Id, "task", cursor, 2, 1)
	if err != nil {
		t.Fatal(err)
	}
	if len(records) != 1 || records[0]["title"] != "second" || cursor != "" || more {
		t.Fatalf("unexpected second snapshot page: records=%v cursor=%q more=%v", records, cursor, more)
	}
}

func TestRestoreExtractionRequiresEmptyTargetAndLocksStartup(t *testing.T) {
	var content bytes.Buffer
	writer := zip.NewWriter(&content)
	entry, err := writer.Create("data.db")
	if err != nil {
		t.Fatal(err)
	}
	if _, err := entry.Write([]byte("database")); err != nil {
		t.Fatal(err)
	}
	if err := writer.Close(); err != nil {
		t.Fatal(err)
	}
	root := t.TempDir()
	archive := filepath.Join(root, "backup.zip")
	if err := os.WriteFile(archive, content.Bytes(), 0o600); err != nil {
		t.Fatal(err)
	}
	target := filepath.Join(root, "restored")
	restoreID := uuid.NewString()
	if err := runRestoreNew([]string{"--backup", archive, "--target", target, "--restore-id", restoreID}); err != nil {
		t.Fatal(err)
	}
	if err := refusePendingRestore(target, false); err == nil {
		t.Fatal("pending restore did not block startup")
	}
	marker, err := os.ReadFile(restoreMarker(target))
	if err != nil || strings.TrimSpace(string(marker)) != restoreID {
		t.Fatalf("unexpected restore marker %q: %v", marker, err)
	}
	if err := runRestoreNew(
		[]string{"--backup", archive, "--target", target, "--restore-id", uuid.NewString()},
	); err == nil {
		t.Fatal("non-empty restore target was accepted")
	}
}

func TestRestoreArchiveCannotReplacePendingMarker(t *testing.T) {
	var content bytes.Buffer
	writer := zip.NewWriter(&content)
	for name, value := range map[string]string{"data.db": "database", restoreMarkerName: "attacker-id"} {
		entry, err := writer.Create(name)
		if err != nil {
			t.Fatal(err)
		}
		if _, err := entry.Write([]byte(value)); err != nil {
			t.Fatal(err)
		}
	}
	if err := writer.Close(); err != nil {
		t.Fatal(err)
	}
	root := t.TempDir()
	archive := filepath.Join(root, "backup.zip")
	if err := os.WriteFile(archive, content.Bytes(), 0o600); err != nil {
		t.Fatal(err)
	}
	target := filepath.Join(root, "restored")
	restoreID := uuid.NewString()
	if err := runRestoreNew([]string{
		"--backup", archive, "--target", target, "--restore-id", restoreID,
	}); err == nil {
		t.Fatal("backup containing restore marker was accepted")
	}
	marker, err := os.ReadFile(restoreMarker(target))
	if err != nil || strings.TrimSpace(string(marker)) != restoreID {
		t.Fatalf("restore marker was bypassed: %q (%v)", marker, err)
	}
}

func TestBinaryHonorsPendingMarkerForCustomDataDir(t *testing.T) {
	root := t.TempDir()
	binary := filepath.Join(root, "freiraum-test")
	build := exec.Command("go", "build", "-o", binary, ".")
	if output, err := build.CombinedOutput(); err != nil {
		t.Fatalf("build test binary: %v\n%s", err, output)
	}
	directory := filepath.Join(root, "restored-data")
	if err := os.MkdirAll(directory, 0o700); err != nil {
		t.Fatal(err)
	}
	restoreID := uuid.NewString()
	if err := os.WriteFile(restoreMarker(directory), []byte(restoreID+"\n"), 0o600); err != nil {
		t.Fatal(err)
	}

	serve := exec.Command(binary, "serve", "--dir", directory, "--http=127.0.0.1:0")
	output, err := serve.CombinedOutput()
	if err == nil || !strings.Contains(string(output), "restore is pending") {
		t.Fatalf("serve did not reject pending custom data dir: err=%v output=%s", err, output)
	}
	if _, err := os.Stat(filepath.Join(directory, "data.db")); !errors.Is(err, os.ErrNotExist) {
		t.Fatalf("rejected serve mutated pending restore: %v", err)
	}

	finalize := exec.Command(
		binary, restoreFinalizeCommand, "--dir", directory, "--restore-id", restoreID,
	)
	output, err = finalize.CombinedOutput()
	if err != nil {
		t.Fatalf("restore-finalize was blocked for custom data dir: %v\n%s", err, output)
	}
	if _, err := os.Stat(restoreMarker(directory)); !errors.Is(err, os.ErrNotExist) {
		t.Fatalf("restore-finalize left marker: %v", err)
	}
}

func TestRestoreFinalizeRotatesGenerationAndAllSessionsIdempotently(t *testing.T) {
	directory := t.TempDir()
	app := openTestApp(t, directory)
	createAuth := func(collection, email string) *core.Record {
		t.Helper()
		c, err := app.FindCollectionByNameOrId(collection)
		if err != nil {
			t.Fatal(err)
		}
		record := core.NewRecord(c)
		record.SetEmail(email)
		record.SetPassword("long-test-password")
		if err := app.Save(record); err != nil {
			t.Fatal(err)
		}
		return record
	}
	user := createAuth("todo_users", "restore-user@example.com")
	superuser := createAuth(core.CollectionNameSuperusers, "restore-admin@example.com")
	oldUserTokenKey := user.TokenKey()
	oldSuperuserTokenKey := superuser.TokenKey()
	oldGeneration, err := syncGeneration(app)
	if err != nil {
		t.Fatal(err)
	}

	if _, err := app.DB().NewQuery(`
		INSERT INTO _oauth_pending(id,data,expires) VALUES ('pending','{}',9999999999);
		INSERT INTO _oauth_tokens(hash,kind,family,owner,data,spent,expires)
		VALUES ('hash','access','family',{:owner},'{}',0,9999999999)
	`).Bind(dbx.Params{"owner": user.Id}).Execute(); err != nil {
		t.Fatal(err)
	}
	createChallenge := func(collection string, values Object) {
		t.Helper()
		c, err := app.FindCollectionByNameOrId(collection)
		if err != nil {
			t.Fatal(err)
		}
		record := core.NewRecord(c)
		record.Load(values)
		if err := app.Save(record); err != nil {
			t.Fatal(err)
		}
	}
	base := Object{"collectionRef": user.Collection().Id, "recordRef": user.Id}
	createChallenge(core.CollectionNameMFAs, Object{
		"collectionRef": base["collectionRef"], "recordRef": base["recordRef"], "method": "otp",
	})
	createChallenge(core.CollectionNameOTPs, Object{
		"collectionRef": base["collectionRef"], "recordRef": base["recordRef"],
		"password": "123456", "sentTo": "restore-user@example.com",
	})
	createChallenge(core.CollectionNameAuthOrigins, Object{
		"collectionRef": base["collectionRef"], "recordRef": base["recordRef"], "fingerprint": "restore-test",
	})

	restoreID := uuid.NewString()
	if err := os.WriteFile(restoreMarker(directory), []byte(restoreID+"\n"), 0o600); err != nil {
		t.Fatal(err)
	}
	if err := finalizeRestore(app, restoreID); err != nil {
		t.Fatal(err)
	}
	if _, err := os.Stat(restoreMarker(directory)); !errors.Is(err, os.ErrNotExist) {
		t.Fatalf("restore marker remained: %v", err)
	}
	newGeneration, err := syncGeneration(app)
	if err != nil || newGeneration == oldGeneration || uuid.Validate(newGeneration) != nil {
		t.Fatalf("generation was not rotated: old=%q new=%q err=%v", oldGeneration, newGeneration, err)
	}
	for _, table := range []string{
		"_oauth_pending", "_oauth_tokens", core.CollectionNameMFAs,
		core.CollectionNameOTPs, core.CollectionNameAuthOrigins,
	} {
		var row struct {
			Count int `db:"count"`
		}
		if err := app.DB().NewQuery("SELECT COUNT(*) count FROM " + table).One(&row); err != nil {
			t.Fatal(err)
		}
		if row.Count != 0 {
			t.Errorf("%s retained %d restored session records", table, row.Count)
		}
	}
	reloadedUser, err := app.FindRecordById("todo_users", user.Id)
	if err != nil {
		t.Fatal(err)
	}
	reloadedSuperuser, err := app.FindRecordById(core.CollectionNameSuperusers, superuser.Id)
	if err != nil {
		t.Fatal(err)
	}
	if reloadedUser.TokenKey() == oldUserTokenKey || reloadedSuperuser.TokenKey() == oldSuperuserTokenKey {
		t.Fatal("restored auth token keys were not rotated")
	}
	if err := finalizeRestore(app, restoreID); err != nil {
		t.Fatalf("idempotent finalize failed: %v", err)
	}
	stableGeneration, err := syncGeneration(app)
	if err != nil || stableGeneration != newGeneration {
		t.Fatalf("idempotent finalize rotated generation again: %q != %q (%v)", stableGeneration, newGeneration, err)
	}
}

func TestProductionConfig(t *testing.T) {
	valid := []string{
		"https://tasks.example.com",
		"https://tasks.example.com:8443",
		"http://localhost:8090",
		"http://127.0.0.1:8090",
		"http://127.0.0.2:8090",
		"http://[::1]:8090",
	}
	for _, origin := range valid {
		t.Run("valid_"+origin, func(t *testing.T) {
			t.Setenv("TODO_PUBLIC_URL", origin)
			t.Setenv("PB_ENCRYPTION_KEY", "0123456789abcdef0123456789abcdef")
			if err := validateProductionConfig(); err != nil {
				t.Fatalf("expected valid production config: %v", err)
			}
		})
	}

	invalid := []string{
		"",
		"http://tasks.example.com",
		"https://tasks.example.com/",
		"https://tasks.example.com/todo",
		"https://tasks.example.com?mode=prod",
		"https://tasks.example.com#fragment",
		"https://user@tasks.example.com",
		"https://:443",
		"https://tasks.example.com:",
		"https://tasks.example.com:notaport",
		"https://tasks.example.com:0",
		"https://tasks.example.com:65536",
	}
	for _, origin := range invalid {
		t.Run("invalid_"+origin, func(t *testing.T) {
			t.Setenv("TODO_PUBLIC_URL", origin)
			t.Setenv("PB_ENCRYPTION_KEY", "0123456789abcdef0123456789abcdef")
			if err := validateProductionConfig(); err == nil {
				t.Fatal("expected invalid production origin")
			}
		})
	}

	t.Setenv("TODO_PUBLIC_URL", "https://tasks.example.com")
	for _, key := range []string{"", "short", strings.Repeat("ä", 16)} {
		t.Setenv("PB_ENCRYPTION_KEY", key)
		if err := validateProductionConfig(); err == nil {
			t.Fatalf("expected invalid encryption key with %d bytes", len([]byte(key)))
		}
	}
}

func openTestApp(t *testing.T, directory string) *pocketbase.PocketBase {
	t.Helper()
	app := pocketbase.NewWithConfig(pocketbase.Config{DefaultDataDir: directory})
	if err := app.Bootstrap(); err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() {
		if err := app.ClearBootstrap(); err != nil {
			t.Error(err)
		}
	})
	if err := app.RunAllMigrations(); err != nil {
		t.Fatal(err)
	}
	return app
}

func TestTokenStorageSurvivesRestartWithoutPlaintextSecrets(t *testing.T) {
	directory := t.TempDir()
	app := openTestApp(t, directory)
	now := time.Now()
	token := &models.Token{ClientID: "client", UserID: "user", Access: secret(), Refresh: secret(),
		AccessCreateAt: now, RefreshCreateAt: now, AccessExpiresIn: time.Minute, RefreshExpiresIn: time.Hour,
		Extension: url.Values{"family": {"grant"}, "resource": {"https://todo.example/api/todo/mcp"}}}
	if err := (oauthStore{app}).Create(context.Background(), token); err != nil {
		t.Fatal(err)
	}
	var rows []tokenRow
	if err := app.DB().NewQuery("SELECT * FROM _oauth_tokens").All(&rows); err != nil {
		t.Fatal(err)
	}
	if len(rows) != 2 {
		t.Fatalf("got %d token rows", len(rows))
	}
	for _, row := range rows {
		if strings.Contains(row.Data, token.Access) || strings.Contains(row.Data, token.Refresh) {
			t.Fatal("plaintext token stored")
		}
	}
	if err := app.ClearBootstrap(); err != nil {
		t.Fatal(err)
	}
	reopened := openTestApp(t, directory)
	store := oauthStore{reopened}
	loaded, err := store.GetByAccess(context.Background(), token.Access)
	if err != nil || loaded.GetUserID() != "user" {
		t.Fatalf("token did not survive restart: %v", err)
	}
	if err := store.revoke("grant"); err != nil {
		t.Fatal(err)
	}
	if _, err := store.GetByRefresh(context.Background(), token.Refresh); err == nil {
		t.Fatal("revoked refresh accepted")
	}
	expired := *token
	expired.Access, expired.Refresh = secret(), ""
	expired.AccessCreateAt = now.Add(-time.Hour)
	if err := store.Create(context.Background(), &expired); err != nil {
		t.Fatal(err)
	}
	if _, err := store.GetByAccess(context.Background(), expired.Access); err == nil {
		t.Fatal("expired access accepted")
	}
}

func TestFailedTokenTransactionRollsBack(t *testing.T) {
	app := openTestApp(t, t.TempDir())
	token := &models.Token{
		Access:          secret(),
		AccessCreateAt:  time.Now(),
		AccessExpiresIn: time.Minute,
		Extension:       url.Values{"family": {"grant"}},
	}
	sentinel := errors.New("abort exchange")
	err := app.RunInTransaction(func(tx core.App) error {
		if err := (oauthStore{tx}).Create(context.Background(), token); err != nil {
			return err
		}
		return sentinel
	})
	if !errors.Is(err, sentinel) {
		t.Fatal(err)
	}
	if _, err := (oauthStore{app}).row(token.Access, "access"); err == nil {
		t.Fatal("rolled-back token remained")
	}
}

func TestProductionRateLimitsMigration(t *testing.T) {
	app := openTestApp(t, t.TempDir())
	limits := app.Settings().RateLimits
	if !limits.Enabled {
		t.Fatal("rate limits are disabled")
	}
	for label, expected := range map[string]struct {
		max      int
		duration int64
	}{
		"*:auth":                   {120, 60},
		"POST /api/oauth/register": {30, 3600},
		"POST /api/oauth/token":    {120, 60},
		"POST /api/todo/mcp":       {600, 60},
		"POST /api/todo/push":      {600, 60},
		"GET /api/todo/pull":       {6000, 60},
		"GET /api/todo/snapshot":   {6000, 60},
	} {
		rule, ok := limits.FindRateLimitRule(
			[]string{label},
			core.RateLimitRuleAudienceAll,
			core.RateLimitRuleAudienceGuest,
		)
		if !ok {
			t.Errorf("missing rate limit %q", label)
			continue
		}
		if label != "*:auth" && rule.Audience != core.RateLimitRuleAudienceGuest {
			t.Errorf("unexpected rate limit audience %q: %+v", label, rule)
		}
		if rule.MaxRequests != expected.max || rule.Duration != expected.duration {
			t.Errorf("unexpected rate limit %q: %+v", label, rule)
		}
	}
}

func TestDevRateLimitOverrideIsRuntimeOnly(t *testing.T) {
	directory := t.TempDir()
	production := openTestApp(t, directory)
	if !production.Settings().RateLimits.Enabled {
		t.Fatal("migration did not persist enabled rate limits")
	}
	if err := production.ClearBootstrap(); err != nil {
		t.Fatal(err)
	}

	dev := pocketbase.NewWithConfig(pocketbase.Config{DefaultDev: true, DefaultDataDir: directory})
	if err := dev.Bootstrap(); err != nil {
		t.Fatal(err)
	}
	if err := dev.RunAllMigrations(); err != nil {
		t.Fatal(err)
	}
	if !dev.Settings().RateLimits.Enabled {
		t.Fatal("persisted setting was disabled before runtime configuration")
	}
	configureRuntimeRateLimits(dev)
	if dev.Settings().RateLimits.Enabled {
		t.Fatal("dev runtime kept rate limits enabled")
	}
	if err := dev.ClearBootstrap(); err != nil {
		t.Fatal(err)
	}

	reopened := openTestApp(t, directory)
	if !reopened.Settings().RateLimits.Enabled {
		t.Fatal("dev runtime override was persisted")
	}
}

func TestOAuthCleanupPreservesActiveReplayEvidence(t *testing.T) {
	app := openTestApp(t, t.TempDir())
	now := time.Unix(2_000_000_000, 0)
	insertPending := func(id string, expires int64) {
		t.Helper()
		_, err := app.DB().
			NewQuery("INSERT INTO _oauth_pending(id,data,expires) VALUES ({:id},'{}',{:expires})").
			Bind(dbx.Params{"id": id, "expires": expires}).
			Execute()
		if err != nil {
			t.Fatal(err)
		}
	}
	insertToken := func(raw, kind, family string, spent int, expires int64) {
		t.Helper()
		_, err := app.DB().NewQuery(`
			INSERT INTO _oauth_tokens(hash,kind,family,owner,data,spent,expires)
			VALUES ({:hash},{:kind},{:family},'owner','{}',{:spent},{:expires})
		`).Bind(dbx.Params{
			"hash": digest(raw), "kind": kind, "family": family,
			"spent": spent, "expires": expires,
		}).Execute()
		if err != nil {
			t.Fatal(err)
		}
	}
	count := func(table, filter string, params dbx.Params) int {
		t.Helper()
		var row struct {
			Count int `db:"count"`
		}
		if err := app.DB().
			NewQuery("SELECT COUNT(*) count FROM " + table + " WHERE " + filter).
			Bind(params).
			One(&row); err != nil {
			t.Fatal(err)
		}
		return row.Count
	}

	insertPending("past", now.Unix()-1)
	insertPending("boundary", now.Unix())
	insertPending("future", now.Unix()+1)
	insertToken("old-refresh", "refresh", "active", 1, now.Unix()+300)
	insertToken("current-refresh", "refresh", "active", 0, now.Unix()+300)
	insertToken("old-access", "access", "active", 1, now.Unix()-1)
	insertToken("dead-refresh", "refresh", "dead", 1, now.Unix()+300)
	insertToken("dead-access", "access", "dead", 0, now.Unix()-1)

	stats, err := cleanupOAuth(app, now)
	if err != nil {
		t.Fatal(err)
	}
	if stats != (oauthCleanupStats{Pending: 2, TokenFamilies: 1, Tokens: 2}) {
		t.Fatalf("unexpected cleanup stats: %+v", stats)
	}
	if got := count("_oauth_pending", "1=1", nil); got != 1 {
		t.Fatalf("got %d pending rows", got)
	}
	if got := count("_oauth_tokens", "family={:family}", dbx.Params{"family": "active"}); got != 3 {
		t.Fatalf("active family lost replay evidence: %d rows", got)
	}
	if got := count("_oauth_tokens", "family={:family}", dbx.Params{"family": "dead"}); got != 0 {
		t.Fatalf("inactive family retained %d rows", got)
	}
	old, err := (oauthStore{app}).row("old-refresh", "refresh")
	if err != nil || old.Spent != 1 {
		t.Fatalf("spent refresh replay evidence missing: %+v, %v", old, err)
	}

	second, err := cleanupOAuth(app, now)
	if err != nil {
		t.Fatal(err)
	}
	if second != (oauthCleanupStats{}) {
		t.Fatalf("cleanup is not idempotent: %+v", second)
	}

	// This is the same family revocation path used when the token endpoint sees
	// the retained spent refresh token again.
	if err := (oauthStore{app}).revoke(old.Family); err != nil {
		t.Fatal(err)
	}
	current, err := (oauthStore{app}).row("current-refresh", "refresh")
	if err != nil || current.Spent != 1 {
		t.Fatalf("replay could not revoke current refresh: %+v, %v", current, err)
	}
}

func TestInferredSchemasEnforceInputContracts(t *testing.T) {
	schema, err := inputSchema[UpdateTaskInput]().Resolve(nil)
	if err != nil {
		t.Fatal(err)
	}
	base := Object{
		"mutationId":       uuid.NewString(),
		"id":               uuid.NewString(),
		"expectedRevision": float64(1),
		"changes":          Object{"dueDate": nil, "completed": false},
	}
	if err := schema.Validate(base); err != nil {
		t.Fatal(err)
	}
	for _, change := range []Object{{}, {"unknown": true}, {"title": " "}, {"completed": nil}, {"listId": "not-uuid"}} {
		base["changes"] = change
		if err := schema.Validate(base); err == nil {
			t.Errorf("accepted invalid changes: %v", change)
		}
	}
	pages, err := inputSchema[PageInput]().Resolve(nil)
	if err != nil {
		t.Fatal(err)
	}
	for _, limit := range []any{float64(0), float64(101), 1.5, nil, "10"} {
		if err := pages.Validate(Object{"limit": limit}); err == nil {
			t.Errorf("accepted invalid limit %v", limit)
		}
	}
	if err := pages.Validate(Object{}); err != nil {
		t.Fatal(err)
	}
}

func TestMergeConvergesAndPreservesTombstones(t *testing.T) {
	initial := Object{
		"title":     "base",
		"completed": false,
		"version":   float64(1),
		"createdAt": float64(1),
		"updatedAt": float64(1),
	}
	edit := func(field string, value any, device string) Object {
		p := Object{}
		for k, v := range initial {
			p[k] = v
		}
		stamps := Object{}
		for _, f := range fields("task") {
			stamps[f] = stamp(initial, f)
		}
		p["fieldVersions"] = stamps
		p["version"] = float64(2)
		p[field] = value
		stamps[field] = Object{"counter": float64(2), "deviceId": device}
		return p
	}
	a := edit("title", "A", "00000000-0000-4000-8000-000000000001")
	b := edit("completed", true, "00000000-0000-4000-8000-000000000002")
	deleted := edit("deletedAt", float64(50), "00000000-0000-4000-8000-000000000001")
	var expected Object
	for _, order := range [][]Object{{a, b, deleted}, {a, deleted, b}, {b, a, deleted}, {b, deleted, a}, {deleted, a, b}, {deleted, b, a}} {
		state := initial
		for _, next := range order {
			var err error
			state, err = merge(state, next, "task")
			if err != nil {
				t.Fatal(err)
			}
		}
		if expected == nil {
			expected = state
		}
		if !reflect.DeepEqual(state, expected) {
			t.Fatal("delivery order changed merge")
		}
		if state["title"] != "A" || state["completed"] != true || state["deletedAt"] != float64(50) {
			t.Fatal(state)
		}
	}
	forged := Object{}
	raw, err := json.Marshal(a)
	if err != nil {
		t.Fatal(err)
	}
	if err := json.Unmarshal(raw, &forged); err != nil {
		t.Fatal(err)
	}
	forged["title"] = "forged"
	if _, err := merge(a, forged, "task"); err == nil {
		t.Fatal("reused stamp accepted")
	}
}

func recurrenceMutation(rule, date, series any) Object {
	owner := uuid.NewString()
	id := uuid.NewString()
	return Object{
		"id":            uuid.NewString(),
		"entityId":      id,
		"entityType":    "task",
		"entityVersion": float64(1),
		"operation":     "create",
		"deviceId":      uuid.NewString(),
		"baseRevision":  float64(0),
		"payload": Object{
			"id": id, "ownerId": owner, "version": float64(1), "title": "repeat",
			"completed": false, "createdAt": float64(1), "updatedAt": float64(1),
			"recurrenceRule": rule, "recurrenceDate": date, "seriesId": series,
		},
	}
}

func TestRecurrencePayloadValidation(t *testing.T) {
	series := uuid.NewString()
	for _, rule := range []string{
		"FREQ=DAILY",
		"FREQ=WEEKLY;INTERVAL=2;BYDAY=TU",
		"FREQ=MONTHLY;BYDAY=2TU",
		"FREQ=YEARLY;BYMONTH=9;BYMONTHDAY=18",
	} {
		m := recurrenceMutation(rule, "2026-09-18", series)
		if err := validateMutation(m, obj(m["payload"])["ownerId"].(string)); err != nil {
			t.Errorf("rejected valid rule %q: %v", rule, err)
		}
	}
	for _, rule := range []string{
		"RRULE:FREQ=WEEKLY",
		"freq=weekly",
		"FREQ=HOURLY",
		"FREQ=DAILY;COUNT=4",
		"FREQ=DAILY;UNTIL=20270101T000000Z",
		"FREQ=DAILY;BYHOUR=9",
		"FREQ=WEEKLY;FREQ=MONTHLY",
		"FREQ=WEEKLY\nBYDAY=TU",
		"FREQ=" + strings.Repeat("D", 507),
	} {
		m := recurrenceMutation(rule, "2026-09-18", series)
		if err := validateMutation(m, obj(m["payload"])["ownerId"].(string)); err == nil {
			t.Errorf("accepted invalid rule %q", rule)
		}
	}
	for _, mutate := range []func(Object){
		func(p Object) { delete(p, "seriesId") },
		func(p Object) { p["recurrenceDate"] = "2026-02-30" },
		func(p Object) { p["seriesId"] = "not-a-uuid" },
		func(p Object) { p["recurrenceRule"] = nil },
	} {
		m := recurrenceMutation("FREQ=WEEKLY", "2026-09-18", series)
		mutate(obj(m["payload"]))
		if err := validateMutation(m, obj(m["payload"])["ownerId"].(string)); err == nil {
			t.Errorf("accepted inconsistent recurrence: %v", m["payload"])
		}
	}
	m := recurrenceMutation(nil, nil, nil)
	if err := validateMutation(m, obj(m["payload"])["ownerId"].(string)); err != nil {
		t.Fatalf("rejected task without recurrence: %v", err)
	}
	m = recurrenceMutation("FREQ=WEEKLY;INTERVAL=2;BYDAY=TU", "2026-09-22", series)
	p := obj(m["payload"])
	stamps := Object{}
	for _, field := range fields("task") {
		counter := float64(0)
		deviceID := ""
		if p[field] != nil {
			counter = 1
			deviceID = str(m["deviceId"])
		}
		stamps[field] = Object{"counter": counter, "deviceId": deviceID}
	}
	p["fieldVersions"] = stamps
	if err := validateMutation(m, p["ownerId"].(string)); err != nil {
		t.Fatalf("rejected recurrence field stamps: %v", err)
	}
}

func TestRecurrenceFieldsMergeWithTheirStamps(t *testing.T) {
	series := uuid.NewString()
	device := uuid.NewString()
	base := Object{
		"title": "repeat", "completed": false, "version": float64(1),
		"createdAt": float64(1), "updatedAt": float64(1),
	}
	next := Object{}
	for k, v := range base {
		next[k] = v
	}
	next["version"] = float64(2)
	next["recurrenceRule"] = "FREQ=WEEKLY;INTERVAL=2;BYDAY=TU"
	next["recurrenceDate"] = "2026-09-22"
	next["seriesId"] = series
	stamps := Object{}
	for _, field := range fields("task") {
		stamps[field] = stamp(base, field)
	}
	for _, field := range []string{"recurrenceRule", "recurrenceDate", "seriesId"} {
		stamps[field] = Object{"counter": float64(2), "deviceId": device}
	}
	next["fieldVersions"] = stamps

	merged, err := merge(base, next, "task")
	if err != nil {
		t.Fatal(err)
	}
	for _, field := range []string{"recurrenceRule", "recurrenceDate", "seriesId"} {
		if merged[field] != next[field] || !reflect.DeepEqual(obj(merged["fieldVersions"])[field], stamps[field]) {
			t.Errorf("field or stamp not merged for %s: %v", field, merged)
		}
	}
}

func TestMCPCompletionCreatesRecurringSuccessorOnce(t *testing.T) {
	app := openTestApp(t, t.TempDir())
	users, err := app.FindCollectionByNameOrId("todo_users")
	if err != nil {
		t.Fatal(err)
	}
	user := core.NewRecord(users)
	user.SetEmail("recurrence@example.com")
	user.SetPassword("long-test-password")
	if err := app.Save(user); err != nil {
		t.Fatal(err)
	}
	owner := user.Id
	series := uuid.NewString()
	created, err := callTool(app, owner, "create_task", Object{
		"mutationId": uuid.NewString(), "title": "fortnightly", "dueDate": "2026-09-20",
		"plannedDate": "2026-09-14", "recurrenceRule": "FREQ=WEEKLY;INTERVAL=2;BYDAY=TU",
		"recurrenceDate": "2026-09-15", "seriesId": series,
	})
	if err != nil {
		t.Fatal(err)
	}
	current := obj(created["entity"])
	mutationID := uuid.NewString()
	completed, err := callTool(app, owner, "complete_task", Object{
		"mutationId": mutationID, "id": current["id"], "expectedRevision": current["remoteRevision"],
	})
	if err != nil {
		t.Fatal(err)
	}
	if obj(completed["entity"])["completed"] != true {
		t.Fatal("source task was not completed")
	}
	nextDate := "2026-09-29"
	nextID := uuid.NewSHA1(uuid.MustParse(series), []byte(nextDate)).String()
	successor, err := entity(app, owner, "task", nextID)
	if err != nil {
		t.Fatal(err)
	}
	if successor["completed"] != false || successor["recurrenceDate"] != nextDate ||
		successor["dueDate"] != "2026-10-04" || successor["plannedDate"] != "2026-09-28" ||
		successor["seriesId"] != series {
		t.Fatalf("unexpected successor: %v", successor)
	}
	if _, err := callTool(app, owner, "complete_task", Object{
		"mutationId": mutationID, "id": current["id"], "expectedRevision": current["remoteRevision"],
	}); err != nil {
		t.Fatal(err)
	}
	completedEntity := obj(completed["entity"])
	if _, err := callTool(app, owner, "complete_task", Object{
		"mutationId": uuid.NewString(), "id": current["id"], "expectedRevision": completedEntity["remoteRevision"],
	}); err != nil {
		t.Fatal(err)
	}
	rows, err := app.FindRecordsByFilter("tasks", "owner={:owner}", "", 10, 0, map[string]any{"owner": owner})
	if err != nil {
		t.Fatal(err)
	}
	if len(rows) != 2 {
		t.Fatalf("retry created duplicates: got %d tasks", len(rows))
	}
}
