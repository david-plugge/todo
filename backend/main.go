package main

import (
	"log"
	"os"

	"github.com/pocketbase/pocketbase"
	"github.com/pocketbase/pocketbase/apis"
	"github.com/pocketbase/pocketbase/core"
	"github.com/pocketbase/pocketbase/plugins/migratecmd"
)

func main() {
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
