package main

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"net/url"
	"regexp"
	"slices"
	"strings"
	"time"

	oauth "github.com/go-oauth2/oauth2/v4"
	"github.com/go-oauth2/oauth2/v4/models"
	"github.com/pocketbase/dbx"
	"github.com/pocketbase/pocketbase/apis"
	"github.com/pocketbase/pocketbase/core"
)

type modelsToken = models.Token

var challengePattern = regexp.MustCompile(`^[A-Za-z0-9_-]{43}$`)
var verifierPattern = regexp.MustCompile(`^[A-Za-z0-9._~-]{43,128}$`)

const (
	// One eager rotation is tolerated for client compatibility. Subsequent
	// rotations in a family must be spaced out so public token requests cannot
	// grow replay evidence at request-rate speed.
	oauthRefreshMinInterval = 10 * time.Minute
	oauthRefreshReplayLimit = 4096
)

func validRedirect(uri string) bool {
	u, err := url.Parse(uri)
	return err == nil && u.Host != "" && u.User == nil && u.Fragment == "" &&
		(u.Scheme == "https" || (u.Scheme == "http" && (u.Hostname() == "127.0.0.1" || u.Hostname() == "localhost" || u.Hostname() == "::1")))
}
func oauthError(e *core.RequestEvent, code string) error { return e.JSON(400, Object{"error": code}) }
func registerOAuth(e *core.ServeEvent) error {
	issuer, err := productionOrigin()
	if err != nil {
		return err
	}
	u, _ := url.Parse(issuer)
	resource := issuer + "/api/todo/mcp"
	guard := func(r *core.RequestEvent) error {
		r.Response.Header().Set("Cache-Control", "no-store")
		r.Response.Header().Set("Pragma", "no-cache")
		origin := r.Request.Header.Get("Origin")
		if origin != "" && origin != issuer {
			return apis.NewForbiddenError("Origin not allowed", nil)
		}
		if r.Request.Host != u.Host {
			return apis.NewForbiddenError("Host not allowed", nil)
		}
		return nil
	}
	e.Router.GET("/.well-known/oauth-protected-resource/api/todo/mcp", func(r *core.RequestEvent) error {
		return r.JSON(
			200,
			Object{
				"resource":                 resource,
				"authorization_servers":    []string{issuer},
				"scopes_supported":         []string{"tasks:read", "tasks:write"},
				"bearer_methods_supported": []string{"header"},
			},
		)
	})
	e.Router.GET("/.well-known/oauth-authorization-server", func(r *core.RequestEvent) error {
		return r.JSON(
			200,
			Object{
				"issuer":                                issuer,
				"authorization_endpoint":                issuer + "/api/oauth/authorize",
				"token_endpoint":                        issuer + "/api/oauth/token",
				"registration_endpoint":                 issuer + "/api/oauth/register",
				"revocation_endpoint":                   issuer + "/api/oauth/revoke",
				"response_types_supported":              []string{"code"},
				"grant_types_supported":                 []string{"authorization_code", "refresh_token"},
				"token_endpoint_auth_methods_supported": []string{"none"},
				"code_challenge_methods_supported":      []string{"S256"},
				"scopes_supported":                      []string{"tasks:read", "tasks:write"},
				"client_id_metadata_document_supported": false,
			},
		)
	})
	e.Router.POST("/api/oauth/register", func(r *core.RequestEvent) error {
		if err := guard(r); err != nil {
			return err
		}
		var c oauthClient
		if r.BindBody(&c) != nil || len(c.Redirects) == 0 || len(c.Redirects) > 10 || len(c.Name) > 200 {
			return oauthError(r, "invalid_client_metadata")
		}
		for _, uri := range c.Redirects {
			if !validRedirect(uri) || len(uri) > 2048 {
				return oauthError(r, "invalid_redirect_uri")
			}
		}
		if c.Method != "" && c.Method != "none" {
			return oauthError(r, "invalid_client_metadata")
		}
		for _, g := range c.Grants {
			if g != "authorization_code" && g != "refresh_token" {
				return oauthError(r, "invalid_client_metadata")
			}
		}
		for _, v := range c.Responses {
			if v != "code" {
				return oauthError(r, "invalid_client_metadata")
			}
		}
		c.ID = secret()
		c.Method = "none"
		c.Grants = []string{"authorization_code", "refresh_token"}
		c.Responses = []string{"code"}
		if c.Name == "" {
			c.Name = "MCP client"
		}
		err := createOAuthClient(r.App, c, time.Now(), oauthClientLimit)
		if errors.Is(err, errOAuthClientCapacity) {
			r.Response.Header().Set("Retry-After", "3600")
			return r.JSON(429, Object{"error": "temporarily_unavailable"})
		}
		if err != nil {
			return err
		}
		return r.JSON(201, c)
	}).Bind(apis.BodyLimit(8192))
	e.Router.GET("/api/oauth/authorize", func(r *core.RequestEvent) error {
		if err := guard(r); err != nil {
			return err
		}
		q := r.Request.URL.Query()
		for _, values := range q {
			if len(values) != 1 {
				return oauthError(r, "invalid_request")
			}
		}
		if q.Get("response_type") != "code" || q.Get("resource") != resource ||
			q.Get("code_challenge_method") != "S256" ||
			!challengePattern.MatchString(q.Get("code_challenge")) ||
			len(q.Get("state")) > 2048 {
			return oauthError(r, "invalid_request")
		}
		scope := q.Get("scope")
		if scope == "" {
			scope = "tasks:read"
			q.Set("scope", scope)
		}
		for _, s := range strings.Fields(scope) {
			if s != "tasks:read" && s != "tasks:write" {
				return oauthError(r, "invalid_scope")
			}
		}
		id := secret()
		invalidClient := false
		err := r.App.RunInTransaction(func(tx core.App) error {
			c, err := (oauthStore{tx}).client(q.Get("client_id"))
			if err != nil || !slices.Contains(c.Redirects, q.Get("redirect_uri")) {
				invalidClient = true
				return nil
			}
			_, err = tx.DB().
				NewQuery("INSERT INTO _oauth_pending(id,data,expires,client_id) VALUES ({:id},{:data},{:expires},{:client})").
				Bind(dbx.Params{"id": digest(id), "data": canonical(q), "expires": time.Now().Add(10 * time.Minute).Unix(), "client": c.ID}).
				Execute()
			return err
		})
		if invalidClient {
			return oauthError(r, "invalid_request")
		}
		if err != nil {
			return err
		}
		return r.Redirect(302, issuer+"/oauth/consent?request="+url.QueryEscape(id))
	})
	pending := func(app core.App, id string) (url.Values, error) {
		var row struct {
			Data string `db:"data"`
		}
		err := app.DB().
			NewQuery("SELECT data FROM _oauth_pending WHERE id={:id} AND expires>{:now}").
			Bind(dbx.Params{"id": digest(id), "now": time.Now().Unix()}).
			One(&row)
		var q url.Values
		if err == nil {
			err = json.Unmarshal([]byte(row.Data), &q)
		}
		return q, err
	}
	e.Router.GET("/api/oauth/consent", func(r *core.RequestEvent) error {
		if err := guard(r); err != nil {
			return err
		}
		q, err := pending(r.App, r.Request.URL.Query().Get("request"))
		if err != nil {
			return oauthError(r, "invalid_request")
		}
		c, err := (oauthStore{r.App}).client(q.Get("client_id"))
		if err != nil {
			return oauthError(r, "invalid_client")
		}
		redirect, _ := url.Parse(q.Get("redirect_uri"))
		return r.JSON(
			200,
			Object{
				"clientName":     c.Name,
				"redirectOrigin": redirect.Scheme + "://" + redirect.Host,
				"scope":          q.Get("scope"),
			},
		)
	})
	e.Router.POST("/api/oauth/consent", func(r *core.RequestEvent) error {
		if err := guard(r); err != nil {
			return err
		}
		var body struct {
			Request string `json:"request"`
			Approve bool   `json:"approve"`
		}
		if r.BindBody(&body) != nil {
			return oauthError(r, "invalid_request")
		}
		var redirect string
		err := r.App.RunInTransaction(func(tx core.App) error {
			q, err := pending(tx, body.Request)
			if err != nil {
				return bad("Request expired or already used")
			}
			target, _ := url.Parse(q.Get("redirect_uri"))
			v := target.Query()
			v.Set("state", q.Get("state"))
			if body.Approve {
				fake := r.Request.Clone(r.Request.Context())
				fake.Form = q
				info, err := manager(
					tx,
				).GenerateAuthToken(r.Request.Context(), oauth.Code, &oauth.TokenGenerateRequest{ClientID: q.Get("client_id"), UserID: r.Auth.Id, RedirectURI: q.Get("redirect_uri"), Scope: q.Get("scope"), CodeChallenge: q.Get("code_challenge"), CodeChallengeMethod: oauth.CodeChallengeS256, Request: fake})
				if err != nil {
					return err
				}
				if _, err = tx.DB().
					NewQuery("UPDATE _oauth_clients SET last_used={:lastUsed} WHERE id={:id}").
					Bind(dbx.Params{"lastUsed": time.Now().Unix(), "id": q.Get("client_id")}).
					Execute(); err != nil {
					return err
				}
				v.Set("code", info.GetCode())
			} else {
				v.Set("error", "access_denied")
			}
			if _, err = tx.DB().
				NewQuery("DELETE FROM _oauth_pending WHERE id={:id}").
				Bind(dbx.Params{"id": digest(body.Request)}).
				Execute(); err != nil {
				return err
			}
			target.RawQuery = v.Encode()
			redirect = target.String()
			return nil
		})
		if err != nil {
			return err
		}
		return r.JSON(200, Object{"redirect": redirect})
	}).Bind(apis.RequireAuth("todo_users"), apis.BodyLimit(4096))
	e.Router.POST("/api/oauth/token", func(r *core.RequestEvent) error {
		if err := guard(r); err != nil {
			return err
		}
		if !strings.HasPrefix(r.Request.Header.Get("Content-Type"), "application/x-www-form-urlencoded") ||
			r.Request.ParseForm() != nil {
			return oauthError(r, "invalid_request")
		}
		q := r.Request.PostForm
		for _, v := range q {
			if len(v) != 1 {
				return oauthError(r, "invalid_request")
			}
		}
		if q.Get("resource") != resource || q.Get("client_secret") != "" {
			return oauthError(r, "invalid_target")
		}
		grant := q.Get("grant_type")
		if grant != "authorization_code" && grant != "refresh_token" {
			return oauthError(r, "unsupported_grant_type")
		}
		kind, raw := "code", q.Get("code")
		if grant == "refresh_token" {
			kind, raw = "refresh", q.Get("refresh_token")
		}
		var result Object
		invalid := false
		retryAfter := int64(0)
		now := time.Now()
		err := r.App.RunInTransaction(func(tx core.App) error {
			store := oauthStore{tx}
			row, err := store.row(raw, kind)
			if err != nil {
				if kind == "refresh" {
					family, replayErr := store.replayedRefreshFamily(raw, now)
					if replayErr == nil {
						invalid = true
						return store.revoke(family)
					}
				}
				return bad("invalid_grant")
			}
			var stored modelsToken
			_ = json.Unmarshal([]byte(row.Data), &stored)
			if stored.ClientID != q.Get("client_id") || stored.Extension.Get("resource") != resource {
				return bad("invalid_grant")
			}
			if row.Spent != 0 {
				invalid = true
				return store.revoke(row.Family)
			}
			user, err := tx.FindRecordById("todo_users", row.Owner)
			if err != nil || user == nil {
				return bad("invalid_grant")
			}
			if grant == "refresh_token" {
				state, err := store.refreshReplays(row.Family)
				if err != nil {
					return err
				}
				if state.Count >= oauthRefreshReplayLimit {
					invalid = true
					return store.revoke(row.Family)
				}
				if state.Count > 0 {
					readyAt := time.Unix(state.LastSpent, 0).Add(oauthRefreshMinInterval)
					if readyAt.After(now) {
						retryAfter = int64((readyAt.Sub(now) + time.Second - 1) / time.Second)
						return nil
					}
				}
			}
			request := &oauth.TokenGenerateRequest{
				ClientID:     q.Get("client_id"),
				RedirectURI:  q.Get("redirect_uri"),
				Code:         q.Get("code"),
				CodeVerifier: q.Get("code_verifier"),
				Refresh:      q.Get("refresh_token"),
				Request:      r.Request,
			}
			var info oauth.TokenInfo
			m := manager(tx)
			if grant == "authorization_code" {
				if !verifierPattern.MatchString(request.CodeVerifier) || request.RedirectURI != stored.RedirectURI {
					return bad("invalid_grant")
				}
				info, err = m.GenerateAccessToken(r.Request.Context(), oauth.AuthorizationCode, request)
			} else {
				if q.Get("scope") != "" && q.Get("scope") != stored.Scope {
					return bad("invalid_scope")
				}
				info, err = m.RefreshAccessToken(r.Request.Context(), request)
				if err == nil {
					_, err = tx.DB().
						NewQuery("DELETE FROM _oauth_tokens WHERE family={:family} AND kind='access' AND hash!={:hash}").
						Bind(dbx.Params{"family": row.Family, "hash": digest(info.GetAccess())}).
						Execute()
				}
			}
			if err != nil {
				return err
			}
			result = Object{
				"access_token":  info.GetAccess(),
				"token_type":    "Bearer",
				"expires_in":    int64(info.GetAccessExpiresIn().Seconds()),
				"refresh_token": info.GetRefresh(),
				"scope":         info.GetScope(),
			}
			return nil
		})
		if err != nil || invalid {
			return oauthError(r, "invalid_grant")
		}
		if retryAfter > 0 {
			r.Response.Header().Set("Retry-After", fmt.Sprintf("%d", retryAfter))
			return r.JSON(429, Object{"error": "temporarily_unavailable"})
		}
		return r.JSON(200, result)
	}).Bind(apis.BodyLimit(8192))
	e.Router.POST("/api/oauth/revoke", func(r *core.RequestEvent) error {
		if err := guard(r); err != nil {
			return err
		}
		if r.Request.ParseForm() != nil {
			return oauthError(r, "invalid_request")
		}
		store := oauthStore{r.App}
		for _, kind := range []string{"access", "refresh"} {
			row, err := store.row(r.Request.PostForm.Get("token"), kind)
			if err == nil {
				var t modelsToken
				if json.Unmarshal([]byte(row.Data), &t) == nil && t.ClientID == r.Request.PostForm.Get("client_id") {
					if err := store.revoke(row.Family); err != nil {
						return err
					}
				}
			}
		}
		return r.JSON(200, Object{})
	}).Bind(apis.BodyLimit(8192))

	e.Router.GET("/api/oauth/connections", func(r *core.RequestEvent) error {
		if err := guard(r); err != nil {
			return err
		}
		var rows []tokenRow
		err := r.App.DB().
			NewQuery("SELECT * FROM _oauth_tokens WHERE owner={:owner} AND kind='refresh' AND spent=0 AND expires>{:now}").
			Bind(dbx.Params{"owner": r.Auth.Id, "now": time.Now().Unix()}).
			All(&rows)
		if err != nil {
			return err
		}
		items := []Object{}
		for _, row := range rows {
			var t modelsToken
			if json.Unmarshal([]byte(row.Data), &t) != nil {
				continue
			}
			c, err := (oauthStore{r.App}).client(t.ClientID)
			if err != nil {
				continue
			}
			items = append(items, Object{"id": row.Family, "name": c.Name, "scope": t.Scope, "expires": row.Expires})
		}
		return r.JSON(200, Object{"items": items})
	}).Bind(apis.RequireAuth("todo_users"))
	e.Router.POST("/api/oauth/connections/{id}/revoke", func(r *core.RequestEvent) error {
		if err := guard(r); err != nil {
			return err
		}
		_, err := r.App.DB().
			NewQuery("UPDATE _oauth_tokens SET spent=1 WHERE owner={:owner} AND family={:family}").
			Bind(dbx.Params{"owner": r.Auth.Id, "family": r.Request.PathValue("id")}).
			Execute()
		if err != nil {
			return err
		}
		return r.JSON(200, Object{})
	}).Bind(apis.RequireAuth("todo_users"))
	handler := newMCP(e.App)
	for _, method := range []string{"POST", "GET", "DELETE"} {
		e.Router.Route(method, "/api/todo/mcp", func(r *core.RequestEvent) error {
			if err := guard(r); err != nil {
				return err
			}
			unauthorized := func() error {
				r.Response.Header().
					Set("WWW-Authenticate", `Bearer resource_metadata="`+issuer+`/.well-known/oauth-protected-resource/api/todo/mcp"`)
				return r.JSON(401, Object{"error": "invalid_token"})
			}
			auth := r.Request.Header.Get("Authorization")
			if !strings.HasPrefix(auth, "Bearer ") {
				return unauthorized()
			}
			info, err := (oauthStore{r.App}).load(strings.TrimPrefix(auth, "Bearer "), "access")
			if err != nil {
				return unauthorized()
			}
			extended, ok := info.(oauth.ExtendableTokenInfo)
			if !ok || extended.GetExtension().Get("resource") != resource {
				return unauthorized()
			}
			if _, err = r.App.FindRecordById("todo_users", info.GetUserID()); err != nil {
				return unauthorized()
			}
			ctx := context.WithValue(
				r.Request.Context(),
				principalKey{},
				principal{Owner: info.GetUserID(), Scope: info.GetScope()},
			)
			handler.ServeHTTP(r.Response, r.Request.WithContext(ctx))
			return nil
		}).Bind(apis.BodyLimit(65536))
	}
	return nil
}
