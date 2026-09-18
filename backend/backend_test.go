package main

import (
	"archive/zip"
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"net/http"
	"net/http/httptest"
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
	"github.com/pocketbase/pocketbase/apis"
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
	restoreClient := testOAuthClient("restore-client")
	if err := createOAuthClient(app, restoreClient, time.Now(), oauthClientLimit); err != nil {
		t.Fatal(err)
	}

	if _, err := app.DB().NewQuery(`
		INSERT INTO _oauth_pending(id,data,expires,client_id)
		VALUES ('pending','{}',9999999999,{:client})
	`).Bind(dbx.Params{"client": restoreClient.ID}).Execute(); err != nil {
		t.Fatal(err)
	}
	if _, err := app.DB().NewQuery(`
		INSERT INTO _oauth_tokens(hash,kind,family,owner,data,spent,expires,client_id)
		VALUES ('hash','access','family',{:owner},{:tokenData},0,9999999999,{:client})
	`).Bind(dbx.Params{
		"owner": user.Id, "client": restoreClient.ID,
		"tokenData": canonical(models.Token{ClientID: restoreClient.ID}),
	}).Execute(); err != nil {
		t.Fatal(err)
	}
	if _, err := app.DB().NewQuery(`
		INSERT INTO _oauth_refresh_replays(hash,family,expires,spent_at)
		VALUES ('replay-hash','family',9999999999,1)
	`).Execute(); err != nil {
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
		"_oauth_pending", "_oauth_tokens", "_oauth_refresh_replays", core.CollectionNameMFAs,
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
	t.Setenv(trustedProxyHeaderEnv, "")
	t.Setenv(trustedProxyCIDRsEnv, "")
	valid := []string{
		"https://tasks.example.com",
		"https://xn--bcher-kva.example",
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
		"https://tasks.example.com:443",
		"https://tasks.example.com:0443",
		"https://TASKS.example.com",
		"HTTPS://tasks.example.com",
		"http://localhost:80",
		"https://bücher.example",
		"https://127.1",
		"https://2130706433",
		"https://0x7f000001",
		"https://0177.0.0.1",
		"https://example.127",
		"https://a.1",
		"https://abc.0x10",
		"https://example.01",
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

func TestTrustedProxyConfigValidation(t *testing.T) {
	tests := []struct {
		name, header, cidrs string
		valid               bool
	}{
		{name: "disabled", valid: true},
		{name: "xff", header: "X-Forwarded-For", cidrs: "10.0.0.1/32, 2001:db8::/48", valid: true},
		{name: "case insensitive header", header: "x-real-ip", cidrs: "10.0.0.0/24", valid: true},
		{name: "missing cidrs", header: "X-Real-IP"},
		{name: "missing header", cidrs: "10.0.0.1/32"},
		{name: "arbitrary header", header: "X-Client-IP", cidrs: "10.0.0.1/32"},
		{name: "invalid cidr", header: "X-Real-IP", cidrs: "10.0.0.1"},
		{name: "global ipv4", header: "X-Forwarded-For", cidrs: "0.0.0.0/0"},
		{name: "global ipv6", header: "X-Forwarded-For", cidrs: "::/0"},
	}
	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			t.Setenv(trustedProxyHeaderEnv, test.header)
			t.Setenv(trustedProxyCIDRsEnv, test.cidrs)
			config, err := parseTrustedProxyConfig()
			if test.valid && (err != nil || (test.header == "") != (config == nil)) {
				t.Fatalf("expected valid proxy config: config=%+v err=%v", config, err)
			}
			if !test.valid && err == nil {
				t.Fatalf("accepted unsafe proxy config: %+v", config)
			}
		})
	}
}

func TestTrustedProxyOnlyAcceptsForwardedIPFromAllowedPeer(t *testing.T) {
	t.Setenv(trustedProxyHeaderEnv, "X-Forwarded-For")
	t.Setenv(trustedProxyCIDRsEnv, "10.0.0.0/24")
	config, err := parseTrustedProxyConfig()
	if err != nil {
		t.Fatal(err)
	}
	app := openTestApp(t, t.TempDir())
	app.Settings().RateLimits.Enabled = true
	app.Settings().RateLimits.Rules = []core.RateLimitRule{{
		Label: "GET /client-ip", Audience: core.RateLimitRuleAudienceAll, MaxRequests: 1, Duration: 60,
	}}
	router, err := apis.NewRouter(app)
	if err != nil {
		t.Fatal(err)
	}
	serve := &core.ServeEvent{App: app, Router: router}
	configureTrustedProxy(serve, config)
	app.Settings().TrustedProxy.Headers = []string{"X-Client-IP"}
	app.Settings().TrustedProxy.UseLeftmostIP = true
	if err := app.Save(app.Settings()); err != nil {
		t.Fatal(err)
	}
	if !reflect.DeepEqual(app.Settings().TrustedProxy.Headers, []string{verifiedClientIPHeader}) ||
		app.Settings().TrustedProxy.UseLeftmostIP {
		t.Fatalf("settings reload replaced authoritative proxy trust: %+v", app.Settings().TrustedProxy)
	}
	router.GET("/client-ip", func(e *core.RequestEvent) error {
		return e.String(http.StatusOK, e.RealIP())
	})
	superusers, err := app.FindCollectionByNameOrId(core.CollectionNameSuperusers)
	if err != nil {
		t.Fatal(err)
	}
	superuser := core.NewRecord(superusers)
	superuser.SetEmail("proxy-admin@example.com")
	superuser.SetPassword("long-test-password")
	if err := app.Save(superuser); err != nil {
		t.Fatal(err)
	}
	superuserToken, err := superuser.NewAuthToken()
	if err != nil {
		t.Fatal(err)
	}
	app.Settings().SuperuserIPs = []string{"203.0.113.9"}
	router.GET("/superuser-ip", func(e *core.RequestEvent) error {
		return e.String(http.StatusOK, "allowed")
	}).Bind(apis.RequireSuperuserAuth())
	mux, err := router.BuildMux()
	if err != nil {
		t.Fatal(err)
	}

	request := func(remote, forwarded, internal string) (int, string) {
		t.Helper()
		recorder := httptest.NewRecorder()
		req := httptest.NewRequest(http.MethodGet, "/client-ip", nil)
		req.RemoteAddr = remote
		req.Header.Set("X-Forwarded-For", forwarded)
		req.Header.Set(verifiedClientIPHeader, internal)
		mux.ServeHTTP(recorder, req)
		return recorder.Code, recorder.Body.String()
	}

	if status, got := request(
		"198.51.100.20:1234",
		"203.0.113.8",
		"203.0.113.9",
	); status != http.StatusOK ||
		got != "198.51.100.20" {
		t.Fatalf("untrusted peer spoofed client IP: status=%d body=%q", status, got)
	}
	if status, _ := request(
		"198.51.100.20:1234",
		"203.0.113.10",
		"203.0.113.11",
	); status != http.StatusTooManyRequests {
		t.Fatalf("untrusted peer bypassed rate limit by changing spoofed headers: status=%d", status)
	}
	if status, got := request(
		"10.0.0.4:1234",
		"198.51.100.2, 203.0.113.8",
		"203.0.113.9",
	); status != http.StatusOK ||
		got != "203.0.113.8" {
		t.Fatalf("trusted proxy client IP not resolved with rightmost semantics: status=%d body=%q", status, got)
	}

	superuserRequest := func(remote, forwarded, internal string) int {
		t.Helper()
		recorder := httptest.NewRecorder()
		req := httptest.NewRequest(http.MethodGet, "/superuser-ip", nil)
		req.RemoteAddr = remote
		req.Header.Set("Authorization", superuserToken)
		req.Header.Set("X-Forwarded-For", forwarded)
		req.Header.Set(verifiedClientIPHeader, internal)
		mux.ServeHTTP(recorder, req)
		return recorder.Code
	}
	if status := superuserRequest(
		"198.51.100.20:1234",
		"203.0.113.9",
		"203.0.113.9",
	); status != http.StatusForbidden {
		t.Fatalf("untrusted peer spoofed the superuser IP allowlist: status=%d", status)
	}
	if status := superuserRequest(
		"10.0.0.4:1234",
		"203.0.113.9",
		"198.51.100.20",
	); status != http.StatusOK {
		t.Fatalf("trusted proxy IP did not satisfy the superuser allowlist: status=%d", status)
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

func testOAuthClient(id string) oauthClient {
	return oauthClient{
		ID: id, Name: "Test client", Redirects: []string{"http://127.0.0.1/callback"},
		Method: "none", Grants: []string{"authorization_code", "refresh_token"},
		Responses: []string{"code"},
	}
}

func countRows(t *testing.T, app core.App, table, filter string, params dbx.Params) int {
	t.Helper()
	var row struct {
		Count int `db:"count"`
	}
	if err := app.DB().NewQuery("SELECT COUNT(*) count FROM " + table + " WHERE " + filter).
		Bind(params).
		One(&row); err != nil {
		t.Fatal(err)
	}
	return row.Count
}

func oauthTestMux(t *testing.T, app core.App) http.Handler {
	t.Helper()
	router, err := apis.NewRouter(app)
	if err != nil {
		t.Fatal(err)
	}
	if err := registerOAuth(&core.ServeEvent{App: app, Router: router}); err != nil {
		t.Fatal(err)
	}
	mux, err := router.BuildMux()
	if err != nil {
		t.Fatal(err)
	}
	return mux
}

func createOAuthTestGrant(
	t *testing.T,
	app core.App,
	clientID string,
	family string,
	now time.Time,
) (access string, refresh string, owner string) {
	t.Helper()
	if err := createOAuthClient(app, testOAuthClient(clientID), now, oauthClientLimit); err != nil {
		t.Fatal(err)
	}
	users, err := app.FindCollectionByNameOrId("todo_users")
	if err != nil {
		t.Fatal(err)
	}
	user := core.NewRecord(users)
	user.SetEmail(uuid.NewString() + "@example.test")
	user.SetPassword("long-test-password")
	if err := app.Save(user); err != nil {
		t.Fatal(err)
	}
	access, refresh = secret(), secret()
	token := &models.Token{
		ClientID: clientID, UserID: user.Id, Access: access, Refresh: refresh,
		AccessCreateAt: now, RefreshCreateAt: now,
		AccessExpiresIn: 15 * time.Minute, RefreshExpiresIn: 30 * 24 * time.Hour,
		Extension: url.Values{
			"family":   {family},
			"resource": {"http://127.0.0.1:8090/api/todo/mcp"},
		},
	}
	if err := (oauthStore{app}).Create(context.Background(), token); err != nil {
		t.Fatal(err)
	}
	return access, refresh, user.Id
}

func TestTokenStorageSurvivesRestartWithoutPlaintextSecrets(t *testing.T) {
	directory := t.TempDir()
	app := openTestApp(t, directory)
	now := time.Now()
	if err := createOAuthClient(app, testOAuthClient("client"), now, oauthClientLimit); err != nil {
		t.Fatal(err)
	}
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
	if err := createOAuthClient(app, testOAuthClient("rollback-client"), time.Now(), oauthClientLimit); err != nil {
		t.Fatal(err)
	}
	token := &models.Token{
		ClientID:        "rollback-client",
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
		if rule.Audience != core.RateLimitRuleAudienceAll {
			t.Errorf("unexpected rate limit audience %q: %+v", label, rule)
		}
		if rule.MaxRequests != expected.max || rule.Duration != expected.duration {
			t.Errorf("unexpected rate limit %q: %+v", label, rule)
		}
	}
}

func TestAuthenticatedTodoPullUsesSpecificRateLimit(t *testing.T) {
	app := openTestApp(t, t.TempDir())
	users, err := app.FindCollectionByNameOrId("todo_users")
	if err != nil {
		t.Fatal(err)
	}
	user := core.NewRecord(users)
	user.SetEmail("rate-limit@example.com")
	user.SetPassword("long-test-password")
	if err := app.Save(user); err != nil {
		t.Fatal(err)
	}
	token, err := user.NewAuthToken()
	if err != nil {
		t.Fatal(err)
	}

	found := false
	settings := app.Settings()
	for i := range settings.RateLimits.Rules {
		rule := &settings.RateLimits.Rules[i]
		if rule.Label == "GET /api/todo/pull" {
			if rule.Audience != core.RateLimitRuleAudienceAll {
				t.Fatalf("authenticated pull rule has ineffective audience %q", rule.Audience)
			}
			rule.MaxRequests = 1
			rule.Duration = 60
			found = true
		}
	}
	if !found {
		t.Fatal("missing pull rate limit")
	}

	router, err := apis.NewRouter(app)
	if err != nil {
		t.Fatal(err)
	}
	registerTodo(&core.ServeEvent{App: app, Router: router})
	mux, err := router.BuildMux()
	if err != nil {
		t.Fatal(err)
	}
	for index, expected := range []int{http.StatusOK, http.StatusTooManyRequests} {
		recorder := httptest.NewRecorder()
		req := httptest.NewRequest(http.MethodGet, "/api/todo/pull", nil)
		req.Header.Set("Authorization", token)
		mux.ServeHTTP(recorder, req)
		if recorder.Code != expected {
			t.Fatalf("request %d: expected %d, got %d: %s", index+1, expected, recorder.Code, recorder.Body.String())
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
	insertClient := func(id string, lastUsed time.Time) {
		t.Helper()
		client := testOAuthClient(id)
		_, err := app.DB().NewQuery(`
			INSERT INTO _oauth_clients(id,data,created,last_used)
			VALUES ({:id},{:data},{:created},{:lastUsed})
		`).Bind(dbx.Params{
			"id": id, "data": canonical(client), "created": lastUsed.Unix(), "lastUsed": lastUsed.Unix(),
		}).Execute()
		if err != nil {
			t.Fatal(err)
		}
	}
	insertPending := func(id, client string, expires int64) {
		t.Helper()
		_, err := app.DB().NewQuery(`
			INSERT INTO _oauth_pending(id,data,expires,client_id)
			VALUES ({:id},{:data},{:expires},{:client})
		`).Bind(dbx.Params{
			"id": id, "data": canonical(url.Values{"client_id": {client}}),
			"expires": expires, "client": client,
		}).Execute()
		if err != nil {
			t.Fatal(err)
		}
	}
	insertToken := func(raw, kind, family, client string, spent int, expires int64) {
		t.Helper()
		_, err := app.DB().NewQuery(`
			INSERT INTO _oauth_tokens(hash,kind,family,owner,data,spent,expires,client_id)
			VALUES ({:hash},{:kind},{:family},'owner',{:data},{:spent},{:expires},{:client})
		`).Bind(dbx.Params{
			"hash": digest(raw), "kind": kind, "family": family,
			"data": canonical(models.Token{ClientID: client}), "client": client,
			"spent": spent, "expires": expires,
		}).Execute()
		if err != nil {
			t.Fatal(err)
		}
	}
	insertReplay := func(raw, family string, expires, spentAt int64) {
		t.Helper()
		_, err := app.DB().NewQuery(`
			INSERT INTO _oauth_refresh_replays(hash,family,expires,spent_at)
			VALUES ({:hash},{:family},{:expires},{:spentAt})
		`).Bind(dbx.Params{
			"hash": digest(raw), "family": family, "expires": expires, "spentAt": spentAt,
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

	stale := now.Add(-oauthClientIdleTTL - time.Second)
	insertClient("unused", stale)
	insertClient("recent", now.Add(-oauthClientIdleTTL+time.Second))
	insertClient("pending-live", stale)
	insertClient("pending-expired", stale)
	insertClient("active-client", stale)
	insertClient("dead-client", stale)
	insertPending("past", "pending-expired", now.Unix()-1)
	insertPending("boundary", "pending-expired", now.Unix())
	insertPending("future", "pending-live", now.Unix()+1)
	insertReplay("old-refresh", "active", now.Unix()+300, now.Unix()-60)
	insertToken("current-refresh", "refresh", "active", "active-client", 0, now.Unix()+300)
	insertToken("old-access", "access", "active", "active-client", 1, now.Unix()-1)
	insertToken("dead-refresh", "refresh", "dead", "dead-client", 1, now.Unix()+300)
	insertToken("dead-access", "access", "dead", "dead-client", 0, now.Unix()-1)

	if _, err := app.DB().NewQuery("DELETE FROM _oauth_clients WHERE id='active-client'").Execute(); err == nil {
		t.Fatal("foreign key allowed deletion of a client with an active grant family")
	}

	stats, err := cleanupOAuth(app, now)
	if err != nil {
		t.Fatal(err)
	}
	if stats != (oauthCleanupStats{Pending: 3, TokenFamilies: 1, Tokens: 2, Clients: 4}) {
		t.Fatalf("unexpected cleanup stats: %+v", stats)
	}
	if got := count("_oauth_pending", "1=1", nil); got != 0 {
		t.Fatalf("got %d pending rows", got)
	}
	if got := count("_oauth_tokens", "family={:family}", dbx.Params{"family": "active"}); got != 2 {
		t.Fatalf("active family lost replay evidence: %d rows", got)
	}
	if got := count("_oauth_tokens", "family={:family}", dbx.Params{"family": "dead"}); got != 0 {
		t.Fatalf("inactive family retained %d rows", got)
	}
	for _, id := range []string{"unused", "pending-live", "pending-expired", "dead-client"} {
		if got := count("_oauth_clients", "id={:id}", dbx.Params{"id": id}); got != 0 {
			t.Errorf("stale unreferenced client %q was retained", id)
		}
	}
	for _, id := range []string{"recent", "active-client"} {
		if got := count("_oauth_clients", "id={:id}", dbx.Params{"id": id}); got != 1 {
			t.Errorf("live or recently used client %q was removed", id)
		}
	}
	family, err := (oauthStore{app}).replayedRefreshFamily("old-refresh", now)
	if err != nil || family != "active" {
		t.Fatalf("spent refresh replay evidence missing: %q, %v", family, err)
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
	if err := (oauthStore{app}).revoke(family); err != nil {
		t.Fatal(err)
	}
	current, err := (oauthStore{app}).row("current-refresh", "refresh")
	if err != nil || current.Spent != 1 {
		t.Fatalf("replay could not revoke current refresh: %+v, %v", current, err)
	}
}

func TestOAuthClientCapacityBoundsDistributedRegistrations(t *testing.T) {
	app := openTestApp(t, t.TempDir())
	now := time.Unix(2_000_000_000, 0)
	const limit = 8
	const attempts = 64

	results := make(chan error, attempts)
	ids := make(chan string, attempts)
	for range attempts {
		go func() {
			id := uuid.NewString()
			err := createOAuthClient(app, testOAuthClient(id), now, limit)
			if err == nil {
				ids <- id
			}
			results <- err
		}()
	}

	succeeded := 0
	for range attempts {
		err := <-results
		switch {
		case err == nil:
			succeeded++
		case errors.Is(err, errOAuthClientCapacity):
		default:
			t.Fatalf("unexpected registration error: %v", err)
		}
	}
	if succeeded != attempts {
		t.Fatalf("capacity failed to rotate tokenless registrations: admitted %d of %d", succeeded, attempts)
	}
	var row struct {
		Count int `db:"count"`
	}
	if err := app.DB().NewQuery("SELECT COUNT(*) count FROM _oauth_clients").One(&row); err != nil {
		t.Fatal(err)
	}
	if row.Count != limit {
		t.Fatalf("database exceeded client capacity: %d", row.Count)
	}

	var clients []struct {
		ID string `db:"id"`
	}
	if err := app.DB().NewQuery("SELECT id FROM _oauth_clients").All(&clients); err != nil {
		t.Fatal(err)
	}
	for _, client := range clients {
		if _, err := app.DB().NewQuery(`
			INSERT INTO _oauth_pending(id,data,expires,client_id)
			VALUES ({:pending},'{}',{:expires},{:client})
		`).Bind(dbx.Params{
			"pending": uuid.NewString(), "expires": now.Add(time.Minute).Unix(), "client": client.ID,
		}).Execute(); err != nil {
			t.Fatal(err)
		}
	}
	// Even fresh unauthenticated pending requests cannot pin all client slots.
	if err := createOAuthClient(app, testOAuthClient("replacement"), now, limit); err != nil {
		t.Fatalf("oldest tokenless client slot was not reclaimed: %v", err)
	}
	if got := countRows(t, app, "_oauth_clients", "1=1", nil); got != limit {
		t.Fatalf("replacement changed capacity: %d", got)
	}
	if got := countRows(t, app, "_oauth_pending", "1=1", nil); got != limit-1 {
		t.Fatalf("reclaimed client left pending keepalive rows: %d", got)
	}
	close(ids)
}

func TestOAuthRegistrationReturns429AtDatabaseCapacity(t *testing.T) {
	t.Setenv("TODO_PUBLIC_URL", "http://127.0.0.1:8090")
	app := openTestApp(t, t.TempDir())
	now := time.Now().Unix()
	if _, err := app.DB().NewQuery(`
		WITH RECURSIVE registrations(position) AS (
			SELECT 1
			UNION ALL
			SELECT position + 1 FROM registrations WHERE position < {:limit}
		)
		INSERT INTO _oauth_clients(id,data,created,last_used)
		SELECT printf('capacity-%04d', position), '{}', {:now}, {:now} FROM registrations
	`).Bind(dbx.Params{"limit": oauthClientLimit, "now": now}).Execute(); err != nil {
		t.Fatal(err)
	}
	if _, err := app.DB().NewQuery(`
		INSERT INTO _oauth_tokens(hash,kind,family,owner,data,spent,expires,client_id)
		SELECT 'hash-' || id, 'refresh', 'family-' || id, 'owner', '{}', 0, {:expires}, id
		FROM _oauth_clients
	`).Bind(dbx.Params{"expires": now + 3600}).Execute(); err != nil {
		t.Fatal(err)
	}

	router, err := apis.NewRouter(app)
	if err != nil {
		t.Fatal(err)
	}
	if err := registerOAuth(&core.ServeEvent{App: app, Router: router}); err != nil {
		t.Fatal(err)
	}
	mux, err := router.BuildMux()
	if err != nil {
		t.Fatal(err)
	}
	recorder := httptest.NewRecorder()
	request := httptest.NewRequest(
		http.MethodPost,
		"http://127.0.0.1:8090/api/oauth/register",
		strings.NewReader(`{"redirect_uris":["http://127.0.0.1/callback"]}`),
	)
	request.Header.Set("Content-Type", "application/json")
	mux.ServeHTTP(recorder, request)
	if recorder.Code != http.StatusTooManyRequests {
		t.Fatalf("capacity response status=%d body=%s", recorder.Code, recorder.Body.String())
	}
	if got := recorder.Header().Get("Retry-After"); got != "3600" {
		t.Fatalf("capacity response Retry-After=%q", got)
	}
	var body Object
	if err := json.Unmarshal(recorder.Body.Bytes(), &body); err != nil || body["error"] != "temporarily_unavailable" {
		t.Fatalf("unexpected capacity response: body=%s err=%v", recorder.Body.String(), err)
	}
	if got := countRows(t, app, "_oauth_clients", "1=1", nil); got != oauthClientLimit {
		t.Fatalf("rejected registration changed capacity: %d", got)
	}
}

func TestOAuthClientUsageRequiresApprovedGrant(t *testing.T) {
	t.Setenv("TODO_PUBLIC_URL", "http://127.0.0.1:8090")
	app := openTestApp(t, t.TempDir())
	registeredAt := time.Now().Add(-time.Hour).Truncate(time.Second)
	client := testOAuthClient("approval-client")
	if err := createOAuthClient(app, client, registeredAt, oauthClientLimit); err != nil {
		t.Fatal(err)
	}
	users, err := app.FindCollectionByNameOrId("todo_users")
	if err != nil {
		t.Fatal(err)
	}
	user := core.NewRecord(users)
	user.SetEmail("approval@example.test")
	user.SetPassword("long-test-password")
	if err := app.Save(user); err != nil {
		t.Fatal(err)
	}
	authToken, err := user.NewAuthToken()
	if err != nil {
		t.Fatal(err)
	}
	mux := oauthTestMux(t, app)
	lastUsed := func() int64 {
		t.Helper()
		var row struct {
			Value int64 `db:"value"`
		}
		if err := app.DB().NewQuery("SELECT last_used value FROM _oauth_clients WHERE id={:id}").
			Bind(dbx.Params{"id": client.ID}).One(&row); err != nil {
			t.Fatal(err)
		}
		return row.Value
	}
	begin := func() string {
		t.Helper()
		query := url.Values{
			"client_id":             {client.ID},
			"redirect_uri":          {client.Redirects[0]},
			"response_type":         {"code"},
			"code_challenge":        {strings.Repeat("a", 43)},
			"code_challenge_method": {"S256"},
			"state":                 {uuid.NewString()},
			"resource":              {"http://127.0.0.1:8090/api/todo/mcp"},
			"scope":                 {"tasks:read"},
		}
		recorder := httptest.NewRecorder()
		request := httptest.NewRequest(http.MethodGet, "/api/oauth/authorize?"+query.Encode(), nil)
		request.Host = "127.0.0.1:8090"
		mux.ServeHTTP(recorder, request)
		if recorder.Code != http.StatusFound {
			t.Fatalf("authorize status=%d body=%s", recorder.Code, recorder.Body.String())
		}
		location, err := url.Parse(recorder.Header().Get("Location"))
		if err != nil {
			t.Fatal(err)
		}
		return location.Query().Get("request")
	}
	consent := func(requestID string, approve bool) {
		t.Helper()
		recorder := httptest.NewRecorder()
		body := bytes.NewBufferString(canonical(Object{"request": requestID, "approve": approve}))
		request := httptest.NewRequest(http.MethodPost, "/api/oauth/consent", body)
		request.Host = "127.0.0.1:8090"
		request.Header.Set("Content-Type", "application/json")
		request.Header.Set("Authorization", authToken)
		mux.ServeHTTP(recorder, request)
		if recorder.Code != http.StatusOK {
			t.Fatalf("consent status=%d body=%s", recorder.Code, recorder.Body.String())
		}
	}

	denied := begin()
	if got := lastUsed(); got != registeredAt.Unix() {
		t.Fatalf("unauthenticated authorize refreshed client usage: %d", got)
	}
	consent(denied, false)
	if got := lastUsed(); got != registeredAt.Unix() {
		t.Fatalf("denied grant refreshed client usage: %d", got)
	}
	approved := begin()
	consent(approved, true)
	if got := lastUsed(); got <= registeredAt.Unix() {
		t.Fatalf("approved grant did not refresh client usage: %d", got)
	}
}

func TestRefreshRotationCompactsEvidenceAndThrottlesAbuse(t *testing.T) {
	t.Setenv("TODO_PUBLIC_URL", "http://127.0.0.1:8090")
	app := openTestApp(t, t.TempDir())
	now := time.Now()
	oldAccess, oldRefresh, _ := createOAuthTestGrant(t, app, "rotation-client", "rotation-family", now)
	mux := oauthTestMux(t, app)
	refresh := func(raw string) *httptest.ResponseRecorder {
		t.Helper()
		form := url.Values{
			"grant_type":    {"refresh_token"},
			"refresh_token": {raw},
			"client_id":     {"rotation-client"},
			"resource":      {"http://127.0.0.1:8090/api/todo/mcp"},
		}
		recorder := httptest.NewRecorder()
		request := httptest.NewRequest(http.MethodPost, "/api/oauth/token", strings.NewReader(form.Encode()))
		request.Host = "127.0.0.1:8090"
		request.Header.Set("Content-Type", "application/x-www-form-urlencoded")
		mux.ServeHTTP(recorder, request)
		return recorder
	}

	first := refresh(oldRefresh)
	if first.Code != http.StatusOK {
		t.Fatalf("first compatible eager refresh failed: status=%d body=%s", first.Code, first.Body.String())
	}
	var tokens struct {
		Access  string `json:"access_token"`
		Refresh string `json:"refresh_token"`
	}
	if err := json.Unmarshal(first.Body.Bytes(), &tokens); err != nil {
		t.Fatal(err)
	}
	store := oauthStore{app}
	if _, err := store.row(oldAccess, "access"); err == nil {
		t.Fatal("spent access token retained a full token row")
	}
	if _, err := store.row(oldRefresh, "refresh"); err == nil {
		t.Fatal("spent refresh token retained a full token row")
	}
	if family, err := store.replayedRefreshFamily(oldRefresh, time.Now()); err != nil || family != "rotation-family" {
		t.Fatalf("compact replay evidence missing: family=%q err=%v", family, err)
	}
	if got := countRows(
		t,
		app,
		"_oauth_tokens",
		"family={:family}",
		dbx.Params{"family": "rotation-family"},
	); got != 2 {
		t.Fatalf("refresh rotation left %d full token rows", got)
	}

	early := refresh(tokens.Refresh)
	if early.Code != http.StatusTooManyRequests || early.Header().Get("Retry-After") == "" {
		t.Fatalf(
			"early repeated refresh was not throttled: status=%d retry=%q body=%s",
			early.Code,
			early.Header().Get("Retry-After"),
			early.Body.String(),
		)
	}
	current, err := store.row(tokens.Refresh, "refresh")
	if err != nil || current.Spent != 0 {
		t.Fatalf("throttling consumed the current refresh token: %+v err=%v", current, err)
	}

	replayed := refresh(oldRefresh)
	if replayed.Code != http.StatusBadRequest {
		t.Fatalf("spent refresh replay status=%d body=%s", replayed.Code, replayed.Body.String())
	}
	current, err = store.row(tokens.Refresh, "refresh")
	if err != nil || current.Spent != 1 {
		t.Fatalf("compact replay evidence did not revoke family: %+v err=%v", current, err)
	}
}

func TestRefreshReplayFamilyHardCapRevokesGrant(t *testing.T) {
	t.Setenv("TODO_PUBLIC_URL", "http://127.0.0.1:8090")
	app := openTestApp(t, t.TempDir())
	now := time.Now()
	_, refresh, _ := createOAuthTestGrant(t, app, "capped-client", "capped-family", now)
	if _, err := app.DB().NewQuery(`
		WITH RECURSIVE evidence(position) AS (
			SELECT 1
			UNION ALL
			SELECT position + 1 FROM evidence WHERE position < {:limit}
		)
		INSERT INTO _oauth_refresh_replays(hash,family,expires,spent_at)
		SELECT printf('capped-%04d', position), 'capped-family', {:expires}, {:spentAt} FROM evidence
	`).Bind(dbx.Params{
		"limit": oauthRefreshReplayLimit, "expires": now.Add(time.Hour).Unix(),
		"spentAt": now.Add(-oauthRefreshMinInterval).Unix(),
	}).Execute(); err != nil {
		t.Fatal(err)
	}
	mux := oauthTestMux(t, app)
	form := url.Values{
		"grant_type":    {"refresh_token"},
		"refresh_token": {refresh},
		"client_id":     {"capped-client"},
		"resource":      {"http://127.0.0.1:8090/api/todo/mcp"},
	}
	recorder := httptest.NewRecorder()
	request := httptest.NewRequest(http.MethodPost, "/api/oauth/token", strings.NewReader(form.Encode()))
	request.Host = "127.0.0.1:8090"
	request.Header.Set("Content-Type", "application/x-www-form-urlencoded")
	mux.ServeHTTP(recorder, request)
	if recorder.Code != http.StatusBadRequest {
		t.Fatalf("family cap status=%d body=%s", recorder.Code, recorder.Body.String())
	}
	row, err := (oauthStore{app}).row(refresh, "refresh")
	if err != nil || row.Spent != 1 {
		t.Fatalf("family cap did not revoke current grant: %+v err=%v", row, err)
	}
	if got := countRows(
		t,
		app,
		"_oauth_refresh_replays",
		"family={:family}",
		dbx.Params{"family": "capped-family"},
	); got != oauthRefreshReplayLimit {
		t.Fatalf("family replay evidence exceeded cap: %d", got)
	}
}

func TestOAuthRetentionUpgradeBackfillsReferencesAndCompactsTokens(t *testing.T) {
	app := pocketbase.NewWithConfig(pocketbase.Config{DefaultDataDir: t.TempDir()})
	if err := app.Bootstrap(); err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() {
		if err := app.ClearBootstrap(); err != nil {
			t.Error(err)
		}
	})
	if err := app.RunSystemMigrations(); err != nil {
		t.Fatal(err)
	}
	for _, sql := range []string{
		`CREATE TABLE _oauth_clients (id TEXT PRIMARY KEY, data TEXT NOT NULL, created INTEGER NOT NULL)`,
		`CREATE TABLE _oauth_pending (id TEXT PRIMARY KEY, data TEXT NOT NULL, expires INTEGER NOT NULL)`,
		`CREATE TABLE _oauth_tokens (hash TEXT PRIMARY KEY, kind TEXT NOT NULL, family TEXT NOT NULL, owner TEXT NOT NULL, data TEXT NOT NULL, spent INTEGER NOT NULL DEFAULT 0, expires INTEGER NOT NULL)`,
		`CREATE INDEX oauth_family ON _oauth_tokens(family)`,
	} {
		if _, err := app.DB().NewQuery(sql).Execute(); err != nil {
			t.Fatal(err)
		}
	}
	for _, file := range []string{
		"1789551000_todo.js",
		"1789552000_oauth.go",
		"1789553000_production_rate_limits.go",
		"1789554000_sync_generation.go",
		"1789555000_authenticated_rate_limits.go",
	} {
		if _, err := app.DB().NewQuery("INSERT INTO _migrations(file,applied) VALUES ({:file},{:applied})").
			Bind(dbx.Params{"file": file, "applied": time.Now().Unix()}).Execute(); err != nil {
			t.Fatal(err)
		}
	}

	created := time.Now().Add(-time.Hour).Unix()
	client := testOAuthClient("legacy-client")
	if _, err := app.DB().NewQuery(`
		INSERT INTO _oauth_clients(id,data,created) VALUES ({:id},{:data},{:created})
	`).Bind(dbx.Params{"id": client.ID, "data": canonical(client), "created": created}).Execute(); err != nil {
		t.Fatal(err)
	}
	if _, err := app.DB().NewQuery(`
		INSERT INTO _oauth_pending(id,data,expires) VALUES ('legacy-pending',{:data},{:expires})
	`).Bind(dbx.Params{
		"data": canonical(url.Values{"client_id": {client.ID}}), "expires": time.Now().Add(time.Minute).Unix(),
	}).Execute(); err != nil {
		t.Fatal(err)
	}
	tokenData := canonical(models.Token{ClientID: client.ID})
	for _, token := range []struct {
		hash, kind string
		spent      int
	}{
		{"legacy-current-refresh", "refresh", 0},
		{"legacy-spent-refresh", "refresh", 1},
		{"legacy-spent-access", "access", 1},
	} {
		if _, err := app.DB().NewQuery(`
			INSERT INTO _oauth_tokens(hash,kind,family,owner,data,spent,expires)
			VALUES ({:hash},{:kind},'legacy-family','owner',{:data},{:spent},{:expires})
		`).Bind(dbx.Params{
			"hash": token.hash, "kind": token.kind, "data": tokenData,
			"spent": token.spent, "expires": time.Now().Add(time.Hour).Unix(),
		}).Execute(); err != nil {
			t.Fatal(err)
		}
	}

	if err := app.RunAllMigrations(); err != nil {
		t.Fatal(err)
	}
	var clientRow struct {
		LastUsed int64 `db:"last_used"`
	}
	if err := app.DB().NewQuery("SELECT last_used FROM _oauth_clients WHERE id={:id}").
		Bind(dbx.Params{"id": client.ID}).One(&clientRow); err != nil || clientRow.LastUsed != created {
		t.Fatalf("client usage backfill failed: %+v err=%v", clientRow, err)
	}
	var pendingRow struct {
		Client string `db:"client_id"`
	}
	if err := app.DB().NewQuery("SELECT client_id FROM _oauth_pending WHERE id='legacy-pending'").
		One(&pendingRow); err != nil || pendingRow.Client != client.ID {
		t.Fatalf("pending client backfill failed: %+v err=%v", pendingRow, err)
	}
	var tokenRow struct {
		Client string `db:"client_id"`
	}
	if err := app.DB().NewQuery("SELECT client_id FROM _oauth_tokens WHERE hash='legacy-current-refresh'").
		One(&tokenRow); err != nil || tokenRow.Client != client.ID {
		t.Fatalf("token client backfill failed: %+v err=%v", tokenRow, err)
	}
	if got := countRows(
		t,
		app,
		"_oauth_tokens",
		"hash IN ('legacy-spent-refresh','legacy-spent-access')",
		nil,
	); got != 0 {
		t.Fatalf("upgrade retained %d spent full token rows", got)
	}
	if got := countRows(t, app, "_oauth_refresh_replays", "hash='legacy-spent-refresh'", nil); got != 1 {
		t.Fatalf("upgrade lost compact refresh replay evidence: %d", got)
	}
	if _, err := app.DB().NewQuery("DELETE FROM _oauth_clients WHERE id={:id}").
		Bind(dbx.Params{"id": client.ID}).Execute(); err == nil {
		t.Fatal("upgraded foreign keys allowed referenced client deletion")
	}
	if _, err := app.DB().NewQuery("INSERT INTO _oauth_pending(id,data,expires) VALUES ('missing-client','{}',1)").
		Execute(); err == nil {
		t.Fatal("upgraded schema accepted a pending row without client_id")
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
