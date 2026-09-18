package main

import (
	"fmt"
	"log"
	"net"
	"net/url"
	"os"
	"strconv"
	"strings"
	"unicode/utf8"

	"github.com/pocketbase/pocketbase"
	"github.com/pocketbase/pocketbase/apis"
	"github.com/pocketbase/pocketbase/core"
	"github.com/pocketbase/pocketbase/plugins/migratecmd"
)

const productionCheckCommand = "production-check"

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
	ip := net.ParseIP(u.Hostname())
	loopback := strings.EqualFold(u.Hostname(), "localhost") || ip != nil && ip.IsLoopback()
	if u.Scheme != "https" && (u.Scheme != "http" || !loopback) {
		return "", fmt.Errorf("TODO_PUBLIC_URL must use HTTPS except for localhost or loopback")
	}
	if u.String() != raw {
		return "", fmt.Errorf("TODO_PUBLIC_URL must be the exact external origin")
	}
	return raw, nil
}

func validateProductionConfig() error {
	if _, err := productionOrigin(); err != nil {
		return err
	}
	key := os.Getenv("PB_ENCRYPTION_KEY")
	if len([]byte(key)) != 32 || utf8.RuneCountInString(key) != 32 {
		return fmt.Errorf("PB_ENCRYPTION_KEY must be exactly 32 single-byte characters")
	}
	return nil
}

func main() {
	// The container entrypoint calls this before PocketBase opens the data directory.
	if len(os.Args) == 2 && os.Args[1] == productionCheckCommand {
		if err := validateProductionConfig(); err != nil {
			log.Fatal(err)
		}
		return
	}
	app := pocketbase.New()
	registerUserCommand(app)
	var public string
	app.RootCmd.PersistentFlags().StringVar(&public, "publicDir", "pb_public", "static application directory")
	migratecmd.MustRegister(app, app.RootCmd, migratecmd.Config{Automigrate: false})
	app.OnServe().BindFunc(func(e *core.ServeEvent) error {
		e.InstallerFunc = nil
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
