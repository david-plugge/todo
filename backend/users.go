package main

import (
	"fmt"
	"os"

	"github.com/pocketbase/pocketbase"
	"github.com/pocketbase/pocketbase/core"
	"github.com/spf13/cobra"
)

func registerUserCommand(app *pocketbase.PocketBase) {
	command := &cobra.Command{
		Use:   "user-create EMAIL",
		Short: "Create an app user; password is read from TODO_USER_PASSWORD",
		Args:  cobra.ExactArgs(1),
		RunE: func(_ *cobra.Command, args []string) error {
			password := os.Getenv("TODO_USER_PASSWORD")
			if len(password) < 8 {
				return fmt.Errorf("TODO_USER_PASSWORD must contain at least 8 characters")
			}
			if err := app.Bootstrap(); err != nil {
				return err
			}
			if err := app.RunAllMigrations(); err != nil {
				return err
			}
			c, err := app.FindCollectionByNameOrId("todo_users")
			if err != nil {
				return err
			}
			r := core.NewRecord(c)
			r.SetEmail(args[0])
			r.SetPassword(password)
			return app.Save(r)
		},
	}
	app.RootCmd.AddCommand(command)
}
