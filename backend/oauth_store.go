package main

import (
	"context"
	"crypto/rand"
	"crypto/sha256"
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"time"

	oauth "github.com/go-oauth2/oauth2/v4"
	"github.com/go-oauth2/oauth2/v4/manage"
	"github.com/go-oauth2/oauth2/v4/models"
	"github.com/pocketbase/dbx"
	"github.com/pocketbase/pocketbase/core"
)

func secret() string {
	b := make([]byte, 32)
	if _, err := rand.Read(b); err != nil {
		panic(err)
	}
	return base64.RawURLEncoding.EncodeToString(b)
}

func digest(s string) string {
	h := sha256.Sum256([]byte(s))
	return hex.EncodeToString(h[:])
}

type oauthClient struct {
	ID        string   `json:"client_id"`
	Name      string   `json:"client_name"`
	Redirects []string `json:"redirect_uris"`
	Method    string   `json:"token_endpoint_auth_method"`
	Grants    []string `json:"grant_types"`
	Responses []string `json:"response_types"`
}
type tokenRow struct {
	Hash    string `db:"hash"`
	Kind    string `db:"kind"`
	Family  string `db:"family"`
	Owner   string `db:"owner"`
	Data    string `db:"data"`
	Spent   int    `db:"spent"`
	Expires int64  `db:"expires"`
}
type oauthStore struct{ app core.App }

func (s oauthStore) client(id string) (oauthClient, error) {
	var row struct {
		Data string `db:"data"`
	}
	err := s.app.DB().NewQuery("SELECT data FROM _oauth_clients WHERE id={:id}").Bind(dbx.Params{"id": id}).One(&row)
	var c oauthClient
	if err == nil {
		err = json.Unmarshal([]byte(row.Data), &c)
	}
	return c, err
}

func (s oauthStore) GetByID(_ context.Context, id string) (oauth.ClientInfo, error) {
	c, err := s.client(id)
	if err != nil {
		return nil, err
	}
	return &models.Client{ID: c.ID, Domain: canonical(c.Redirects), Public: true}, nil
}

func (s oauthStore) row(token, kind string) (tokenRow, error) {
	var row tokenRow
	err := s.app.DB().
		NewQuery("SELECT * FROM _oauth_tokens WHERE hash={:hash} AND kind={:kind}").
		Bind(dbx.Params{"hash": digest(token), "kind": kind}).
		One(&row)
	return row, err
}

func (s oauthStore) load(token, kind string) (oauth.TokenInfo, error) {
	row, err := s.row(token, kind)
	if err != nil || row.Spent != 0 || row.Expires <= time.Now().Unix() {
		return nil, fmt.Errorf("invalid or expired token")
	}
	var t models.Token
	if err = json.Unmarshal([]byte(row.Data), &t); err != nil {
		return nil, err
	}
	switch kind {
	case "code":
		t.Code = token
	case "access":
		t.Access = token
	case "refresh":
		t.Refresh = token
	}
	return &t, nil
}

func (s oauthStore) Create(_ context.Context, info oauth.TokenInfo) error {
	b, err := json.Marshal(info)
	if err != nil {
		return err
	}
	var t models.Token
	if err = json.Unmarshal(b, &t); err != nil {
		return err
	}
	code, access, refresh := t.Code, t.Access, t.Refresh
	t.Code = ""
	t.Access = ""
	t.Refresh = ""
	b, err = json.Marshal(t)
	if err != nil {
		return err
	}
	for _, item := range []struct {
		value, kind string
		expires     time.Time
	}{{code, "code", t.CodeCreateAt.Add(t.CodeExpiresIn)}, {access, "access", t.AccessCreateAt.Add(t.AccessExpiresIn)}, {refresh, "refresh", t.RefreshCreateAt.Add(t.RefreshExpiresIn)}} {
		if item.value == "" {
			continue
		}
		_, err = s.app.DB().
			NewQuery("INSERT INTO _oauth_tokens(hash,kind,family,owner,data,expires) VALUES ({:hash},{:kind},{:family},{:owner},{:data},{:expires})").
			Bind(dbx.Params{"hash": digest(item.value), "kind": item.kind, "family": t.Extension.Get("family"), "owner": t.UserID, "data": string(b), "expires": item.expires.Unix()}).
			Execute()
		if err != nil {
			return err
		}
	}
	return nil
}

func (s oauthStore) remove(token, kind string) error {
	_, err := s.app.DB().
		NewQuery("UPDATE _oauth_tokens SET spent=1 WHERE hash={:hash} AND kind={:kind}").
		Bind(dbx.Params{"hash": digest(token), "kind": kind}).
		Execute()
	return err
}

func (s oauthStore) revoke(family string) error {
	_, err := s.app.DB().
		NewQuery("UPDATE _oauth_tokens SET spent=1 WHERE family={:family}").
		Bind(dbx.Params{"family": family}).
		Execute()
	return err
}

func (s oauthStore) RemoveByCode(_ context.Context, v string) error { return s.remove(v, "code") }

func (s oauthStore) RemoveByAccess(_ context.Context, v string) error { return s.remove(v, "access") }

func (s oauthStore) RemoveByRefresh(_ context.Context, v string) error { return s.remove(v, "refresh") }

func (s oauthStore) GetByCode(_ context.Context, v string) (oauth.TokenInfo, error) {
	return s.load(v, "code")
}

func (s oauthStore) GetByAccess(_ context.Context, v string) (oauth.TokenInfo, error) {
	return s.load(v, "access")
}

func (s oauthStore) GetByRefresh(_ context.Context, v string) (oauth.TokenInfo, error) {
	return s.load(v, "refresh")
}

type codeGenerator struct{}

func (codeGenerator) Token(context.Context, *oauth.GenerateBasic) (string, error) {
	return secret(), nil
}

type accessGenerator struct{}

func (accessGenerator) Token(_ context.Context, _ *oauth.GenerateBasic, refresh bool) (string, string, error) {
	r := ""
	if refresh {
		r = secret()
	}
	return secret(), r, nil
}

func manager(app core.App) *manage.Manager {
	m := manage.NewDefaultManager()
	store := oauthStore{app}
	m.MapClientStorage(store)
	m.MapTokenStorage(store)
	m.MapAuthorizeGenerate(codeGenerator{})
	m.MapAccessGenerate(accessGenerator{})
	m.SetAuthorizeCodeExp(2 * time.Minute)
	m.SetAuthorizeCodeTokenCfg(
		&manage.Config{AccessTokenExp: 15 * time.Minute, RefreshTokenExp: 30 * 24 * time.Hour, IsGenerateRefresh: true},
	)
	m.SetRefreshTokenCfg(
		&manage.RefreshingConfig{
			AccessTokenExp:     15 * time.Minute,
			IsGenerateRefresh:  true,
			IsRemoveRefreshing: true,
			IsRemoveAccess:     false,
			IsResetRefreshTime: false,
		},
	)
	m.SetValidateURIHandler(func(base, redirect string) error {
		var allowed []string
		if json.Unmarshal([]byte(base), &allowed) != nil {
			return fmt.Errorf("invalid client")
		}
		for _, uri := range allowed {
			if redirect == uri {
				return nil
			}
		}
		return fmt.Errorf("redirect mismatch")
	})
	m.SetExtractExtensionHandler(func(req *oauth.TokenGenerateRequest, t oauth.ExtendableTokenInfo) {
		v := t.GetExtension()
		if v == nil {
			v = make(map[string][]string)
		}
		if v.Get("family") == "" {
			v.Set("family", secret())
		}
		if req.Request != nil && v.Get("resource") == "" {
			v.Set("resource", req.Request.FormValue("resource"))
		}
		t.SetExtension(v)
	})
	return m
}
