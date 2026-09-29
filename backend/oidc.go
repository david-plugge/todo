package main

import (
	"fmt"
	"net"
	"net/url"
	"os"
	"strings"

	"github.com/pocketbase/pocketbase/core"
	"github.com/pocketbase/pocketbase/tools/auth"
)

const (
	oidcAuthURLEnv          = "TODO_OIDC_AUTH_URL"
	oidcTokenURLEnv         = "TODO_OIDC_TOKEN_URL"
	oidcUserInfoURLEnv      = "TODO_OIDC_USERINFO_URL"
	oidcClientIDEnv         = "TODO_OIDC_CLIENT_ID"
	oidcClientSecretFileEnv = "TODO_OIDC_CLIENT_SECRET_FILE"
	oidcDisplayNameEnv      = "TODO_OIDC_DISPLAY_NAME"
	oidcDefaultDisplayName  = "OIDC"
	// New app users may only be created by a completed OIDC sign-in.
	oidcCreateRule = `@request.context = "oauth2"`
)

var oidcRequiredEnvs = []string{
	oidcAuthURLEnv,
	oidcTokenURLEnv,
	oidcUserInfoURLEnv,
	oidcClientIDEnv,
	oidcClientSecretFileEnv,
}

type oidcConfig struct {
	authURL      string
	tokenURL     string
	userInfoURL  string
	clientID     string
	clientSecret string
	displayName  string
}

// parseOIDCConfig returns nil when no OIDC variable is set, keeping password
// sign-in for development and tests. A partial configuration is rejected.
func parseOIDCConfig() (*oidcConfig, error) {
	var missing []string
	for _, name := range oidcRequiredEnvs {
		if strings.TrimSpace(os.Getenv(name)) == "" {
			missing = append(missing, name)
		}
	}
	if len(missing) == len(oidcRequiredEnvs) && strings.TrimSpace(os.Getenv(oidcDisplayNameEnv)) == "" {
		return nil, nil
	}
	if len(missing) > 0 {
		return nil, fmt.Errorf("OIDC sign-in is partially configured; also set %s", strings.Join(missing, ", "))
	}
	config := &oidcConfig{
		clientID:    strings.TrimSpace(os.Getenv(oidcClientIDEnv)),
		displayName: strings.TrimSpace(os.Getenv(oidcDisplayNameEnv)),
	}
	if config.displayName == "" {
		config.displayName = oidcDefaultDisplayName
	}
	for _, endpoint := range []struct {
		env    string
		target *string
	}{
		{oidcAuthURLEnv, &config.authURL},
		{oidcTokenURLEnv, &config.tokenURL},
		{oidcUserInfoURLEnv, &config.userInfoURL},
	} {
		value, err := oidcEndpoint(endpoint.env)
		if err != nil {
			return nil, err
		}
		*endpoint.target = value
	}
	secretFile := strings.TrimSpace(os.Getenv(oidcClientSecretFileEnv))
	secret, err := os.ReadFile(secretFile)
	if err != nil {
		return nil, fmt.Errorf("%s cannot be read: %w", oidcClientSecretFileEnv, err)
	}
	config.clientSecret = strings.TrimSpace(string(secret))
	if config.clientSecret == "" {
		return nil, fmt.Errorf("%s points to an empty file", oidcClientSecretFileEnv)
	}
	return config, nil
}

func oidcEndpoint(env string) (string, error) {
	raw := strings.TrimSpace(os.Getenv(env))
	u, err := url.Parse(raw)
	if err != nil || u.Host == "" || u.User != nil || u.Fragment != "" {
		return "", fmt.Errorf("%s must be an absolute URL", env)
	}
	hostname := strings.ToLower(u.Hostname())
	ip := net.ParseIP(hostname)
	loopback := hostname == "localhost" || ip != nil && ip.IsLoopback()
	if u.Scheme != "https" && (u.Scheme != "http" || !loopback) {
		return "", fmt.Errorf("%s must use HTTPS except for localhost or loopback", env)
	}
	return raw, nil
}

// applySignInConfig is deliberately authoritative: the environment decides the
// sign-in methods on every start, so dashboard edits cannot reopen password
// sign-in or register another provider behind the deployment's back.
func applySignInConfig(app core.App, config *oidcConfig) error {
	users, err := app.FindCollectionByNameOrId("todo_users")
	if err != nil {
		return err
	}
	if config == nil {
		users.PasswordAuth.Enabled = true
		users.OAuth2.Enabled = false
		users.OAuth2.Providers = nil
		users.CreateRule = nil
		return app.Save(users)
	}
	pkce := true
	createRule := oidcCreateRule
	users.PasswordAuth.Enabled = false
	users.OAuth2.Enabled = true
	users.OAuth2.Providers = []core.OAuth2ProviderConfig{{
		Name:         auth.NameOIDC,
		DisplayName:  config.displayName,
		ClientId:     config.clientID,
		ClientSecret: config.clientSecret,
		AuthURL:      config.authURL,
		TokenURL:     config.tokenURL,
		UserInfoURL:  config.userInfoURL,
		PKCE:         &pkce,
	}}
	users.CreateRule = &createRule
	return app.Save(users)
}
