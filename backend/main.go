package main

import (
	"fmt"
	"log"
	"net"
	"net/netip"
	"net/url"
	"os"
	"strconv"
	"strings"
	"unicode/utf8"

	"github.com/pocketbase/pocketbase"
	"github.com/pocketbase/pocketbase/apis"
	"github.com/pocketbase/pocketbase/core"
	"github.com/pocketbase/pocketbase/plugins/migratecmd"
	"github.com/pocketbase/pocketbase/tools/hook"
)

const productionCheckCommand = "production-check"

const (
	trustedProxyHeaderEnv  = "TODO_TRUSTED_PROXY_HEADER"
	trustedProxyCIDRsEnv   = "TODO_TRUSTED_PROXY_CIDRS"
	verifiedClientIPHeader = "X-Todo-Verified-Client-IP"
	trustedProxyReloadHook = "todoTrustedProxyReload"
)

type trustedProxyConfig struct {
	header string
	peers  []netip.Prefix
}

var allowedTrustedProxyHeaders = map[string]string{
	"x-forwarded-for":  "X-Forwarded-For",
	"x-real-ip":        "X-Real-IP",
	"cf-connecting-ip": "CF-Connecting-IP",
}

func canonicalOrigin(u *url.URL) string {
	scheme := strings.ToLower(u.Scheme)
	hostname := strings.ToLower(u.Hostname())
	if ip := net.ParseIP(hostname); ip != nil {
		hostname = ip.String()
	}
	port := u.Port()
	if port != "" {
		if number, err := strconv.Atoi(port); err == nil {
			port = strconv.Itoa(number)
		}
	}
	if (scheme == "https" && port == "443") || (scheme == "http" && port == "80") {
		port = ""
	}
	host := hostname
	if port != "" {
		host = net.JoinHostPort(hostname, port)
	} else if strings.Contains(hostname, ":") {
		host = "[" + hostname + "]"
	}
	return scheme + "://" + host
}

func canonicalDNSHostname(host string) bool {
	if host == "" || len(host) > 253 || strings.HasSuffix(host, ".") {
		return false
	}
	hasLetter := false
	labels := strings.Split(host, ".")
	numericLastLabel := false
	for index, label := range labels {
		if len(label) == 0 || len(label) > 63 || label[0] == '-' || label[len(label)-1] == '-' {
			return false
		}
		for _, char := range []byte(label) {
			switch {
			case char >= 'a' && char <= 'z':
				hasLetter = true
			case char >= '0' && char <= '9', char == '-':
			default:
				return false
			}
		}
		numericLabel := true
		if strings.HasPrefix(label, "0x") && len(label) > 2 {
			for _, char := range []byte(label[2:]) {
				if (char < '0' || char > '9') && (char < 'a' || char > 'f') {
					numericLabel = false
					break
				}
			}
		} else {
			for _, char := range []byte(label) {
				if char < '0' || char > '9' {
					numericLabel = false
					break
				}
			}
		}
		if index == len(labels)-1 {
			numericLastLabel = numericLabel
		}
	}
	// WHATWG attempts IPv4 parsing whenever the final label is a decimal,
	// octal, or hexadecimal number. A nonnumeric DNS TLD keeps those browser-
	// normalized or browser-rejected forms out of the byte-exact OAuth contract.
	return hasLetter && !numericLastLabel
}

func productionOrigin() (string, error) {
	raw := os.Getenv("TODO_PUBLIC_URL")
	if raw == "" {
		return "", fmt.Errorf("TODO_PUBLIC_URL is required")
	}
	u, err := url.Parse(raw)
	if err != nil || u.Host == "" || u.Hostname() == "" || u.User != nil || u.Opaque != "" {
		return "", fmt.Errorf("TODO_PUBLIC_URL must be an absolute origin")
	}
	if u.Path != "" || u.RawPath != "" || u.RawQuery != "" || u.ForceQuery || u.Fragment != "" {
		return "", fmt.Errorf("TODO_PUBLIC_URL must contain an origin only and no trailing slash")
	}
	if strings.HasSuffix(u.Host, ":") {
		return "", fmt.Errorf("TODO_PUBLIC_URL must not contain an empty port")
	}
	if port := u.Port(); port != "" {
		n, err := strconv.Atoi(port)
		if err != nil || n < 1 || n > 65535 {
			return "", fmt.Errorf("TODO_PUBLIC_URL port must be between 1 and 65535")
		}
	}
	hostname := strings.ToLower(u.Hostname())
	ip := net.ParseIP(hostname)
	if ip == nil && !canonicalDNSHostname(hostname) {
		return "", fmt.Errorf("TODO_PUBLIC_URL hostname must be a canonical IP or ASCII DNS name")
	}
	loopback := hostname == "localhost" || ip != nil && ip.IsLoopback()
	if u.Scheme != "https" && (u.Scheme != "http" || !loopback) {
		return "", fmt.Errorf("TODO_PUBLIC_URL must use HTTPS except for localhost or loopback")
	}
	canonical := canonicalOrigin(u)
	if canonical != raw {
		return "", fmt.Errorf("TODO_PUBLIC_URL must be the browser-canonical external origin %q", canonical)
	}
	return canonical, nil
}

func parseTrustedProxyConfig() (*trustedProxyConfig, error) {
	rawHeader := strings.TrimSpace(os.Getenv(trustedProxyHeaderEnv))
	rawCIDRs := strings.TrimSpace(os.Getenv(trustedProxyCIDRsEnv))
	if rawHeader == "" && rawCIDRs == "" {
		return nil, nil
	}
	if rawHeader == "" || rawCIDRs == "" {
		return nil, fmt.Errorf("%s and %s must be configured together", trustedProxyHeaderEnv, trustedProxyCIDRsEnv)
	}
	header, ok := allowedTrustedProxyHeaders[strings.ToLower(rawHeader)]
	if !ok {
		return nil, fmt.Errorf(
			"%s must be one of X-Forwarded-For, X-Real-IP, or CF-Connecting-IP",
			trustedProxyHeaderEnv,
		)
	}
	parts := strings.Split(rawCIDRs, ",")
	peers := make([]netip.Prefix, 0, len(parts))
	for _, part := range parts {
		part = strings.TrimSpace(part)
		prefix, err := netip.ParsePrefix(part)
		if err != nil || prefix.Bits() == 0 {
			return nil, fmt.Errorf("%s must contain explicit non-global CIDR prefixes", trustedProxyCIDRsEnv)
		}
		peers = append(peers, prefix.Masked())
	}
	return &trustedProxyConfig{header: header, peers: peers}, nil
}

func (c *trustedProxyConfig) trusts(remoteIP string) bool {
	addr, err := netip.ParseAddr(remoteIP)
	if err != nil {
		return false
	}
	for _, peer := range c.peers {
		if peer.Contains(addr) {
			return true
		}
	}
	return false
}

func forwardedClientIP(header string, values []string) (string, bool) {
	if len(values) == 0 {
		return "", false
	}
	raw := strings.TrimSpace(values[len(values)-1])
	if header == "X-Forwarded-For" {
		parts := strings.Split(raw, ",")
		for i := len(parts) - 1; i >= 0; i-- {
			if addr, err := netip.ParseAddr(strings.TrimSpace(parts[i])); err == nil {
				return addr.String(), true
			}
		}
		return "", false
	}
	if strings.Contains(raw, ",") {
		return "", false
	}
	addr, err := netip.ParseAddr(raw)
	if err != nil {
		return "", false
	}
	return addr.String(), true
}

func applyTrustedProxySettings(app core.App, config *trustedProxyConfig) {
	// Runtime configuration is deliberately authoritative. Persisted dashboard
	// headers are never trusted without an explicit direct-peer allowlist.
	app.Settings().TrustedProxy.Headers = nil
	app.Settings().TrustedProxy.UseLeftmostIP = false
	if config != nil {
		app.Settings().TrustedProxy.Headers = []string{verifiedClientIPHeader}
	}
}

func configureTrustedProxy(e *core.ServeEvent, config *trustedProxyConfig) {
	applyTrustedProxySettings(e.App, config)
	e.App.OnSettingsReload().Bind(&hook.Handler[*core.SettingsReloadEvent]{
		Id: trustedProxyReloadHook,
		Func: func(event *core.SettingsReloadEvent) error {
			if err := event.Next(); err != nil {
				return err
			}
			applyTrustedProxySettings(event.App, config)
			return nil
		},
	})
	if config == nil {
		return
	}
	e.Router.Bind(&hook.Handler[*core.RequestEvent]{
		// Run before auth loading and the superuser IP allowlist. Otherwise an
		// untrusted request could present the private header during that earlier
		// RealIP security check even though it is removed before rate limiting.
		Priority: apis.DefaultLoadAuthTokenMiddlewarePriority - 1,
		Func: func(request *core.RequestEvent) error {
			values := append([]string(nil), request.Request.Header.Values(config.header)...)
			request.Request.Header.Del(config.header)
			request.Request.Header.Del(verifiedClientIPHeader)
			if config.trusts(request.RemoteIP()) {
				if clientIP, ok := forwardedClientIP(config.header, values); ok {
					request.Request.Header.Set(verifiedClientIPHeader, clientIP)
				}
			}
			return request.Next()
		},
	})
}

func validateProductionConfig() error {
	if _, err := productionOrigin(); err != nil {
		return err
	}
	key := os.Getenv("PB_ENCRYPTION_KEY")
	if len([]byte(key)) != 32 || utf8.RuneCountInString(key) != 32 {
		return fmt.Errorf("PB_ENCRYPTION_KEY must be exactly 32 single-byte characters")
	}
	if _, err := parseTrustedProxyConfig(); err != nil {
		return err
	}
	return nil
}

func configureRuntimeRateLimits(app core.App) {
	// PocketBase's limiter is intentionally IP-wide. All isolated Playwright
	// contexts share one loopback IP, so dev-mode suites would otherwise consume
	// each other's production buckets. This is runtime-only and never saved.
	if app.IsDev() {
		app.Settings().RateLimits.Enabled = false
	}
}

func main() {
	// The container entrypoint calls this before PocketBase opens the data directory.
	if len(os.Args) == 2 && os.Args[1] == productionCheckCommand {
		if err := validateProductionConfig(); err != nil {
			log.Fatal(err)
		}
		return
	}
	if len(os.Args) > 1 && os.Args[1] == restoreNewCommand {
		if err := runRestoreNew(os.Args[2:]); err != nil {
			log.Fatal(err)
		}
		return
	}
	app := pocketbase.New()
	finalizingRestore := len(os.Args) > 1 && os.Args[1] == restoreFinalizeCommand
	registerRestoreGuard(app, finalizingRestore)
	registerUserCommand(app)
	registerBackupCommand(app)
	registerRestoreFinalizeCommand(app)
	if err := registerMaintenance(app); err != nil {
		log.Fatal(err)
	}
	var public string
	app.RootCmd.PersistentFlags().StringVar(&public, "publicDir", "pb_public", "static application directory")
	migratecmd.MustRegister(app, app.RootCmd, migratecmd.Config{Automigrate: false})
	app.OnServe().BindFunc(func(e *core.ServeEvent) error {
		e.InstallerFunc = nil
		proxy, err := parseTrustedProxyConfig()
		if err != nil {
			return err
		}
		configureTrustedProxy(e, proxy)
		configureRuntimeRateLimits(e.App)
		registerTodo(e)
		if err := registerOAuth(e); err != nil {
			return err
		}
		e.Router.GET("/{path...}", apis.Static(os.DirFS(public), true))
		return e.Next()
	})

	if err := app.Start(); err != nil {
		log.Fatal(err)
	}
}
