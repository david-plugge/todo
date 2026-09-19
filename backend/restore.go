package main

import (
	"archive/zip"
	"errors"
	"flag"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"strings"

	"github.com/google/uuid"
	"github.com/pocketbase/dbx"
	"github.com/pocketbase/pocketbase"
	"github.com/pocketbase/pocketbase/core"
	"github.com/spf13/cobra"
)

const (
	restoreNewCommand      = "restore-new"
	restoreFinalizeCommand = "restore-finalize"
	restoreMarkerName      = ".todo-restore-pending"
)

func restoreMarker(dataDir string) string { return filepath.Join(dataDir, restoreMarkerName) }

func refusePendingRestore(dataDir string, finalizing bool) error {
	if finalizing {
		return nil
	}
	if _, err := os.Stat(restoreMarker(dataDir)); err == nil {
		return fmt.Errorf("restore is pending in %s; finalize it before starting the server", dataDir)
	} else if !errors.Is(err, os.ErrNotExist) {
		return err
	}
	return nil
}

// registerRestoreGuard checks the final PocketBase data directory during
// bootstrap, after persistent CLI flags such as `serve --dir ...` are parsed,
// but before PocketBase opens or mutates the restored databases.
func registerRestoreGuard(app *pocketbase.PocketBase, finalizing bool) {
	app.OnBootstrap().BindFunc(func(e *core.BootstrapEvent) error {
		if err := refusePendingRestore(e.App.DataDir(), finalizing); err != nil {
			return err
		}
		return e.Next()
	})
}

func runRestoreNew(args []string) error {
	flags := flag.NewFlagSet(restoreNewCommand, flag.ContinueOnError)
	backup := flags.String("backup", "", "local PocketBase backup zip")
	target := flags.String("target", "", "new empty data directory")
	restoreID := flags.String("restore-id", "", "external restore UUID")
	if err := flags.Parse(args); err != nil {
		return err
	}
	if *backup == "" || *target == "" || uuid.Validate(*restoreID) != nil {
		return errors.New("--backup, --target and a UUID --restore-id are required")
	}
	absTarget, err := filepath.Abs(*target)
	if err != nil {
		return err
	}
	entries, err := os.ReadDir(absTarget)
	if err != nil && !errors.Is(err, os.ErrNotExist) {
		return err
	}
	if err == nil && len(entries) != 0 {
		return fmt.Errorf("restore target must be empty: %s", absTarget)
	}
	if err := os.MkdirAll(absTarget, 0o700); err != nil {
		return err
	}
	if err := os.WriteFile(restoreMarker(absTarget), []byte(*restoreID+"\n"), 0o600); err != nil {
		return err
	}
	if err := extractBackup(*backup, absTarget); err != nil {
		return fmt.Errorf("restore extraction failed; target remains locked: %w", err)
	}
	if info, err := os.Stat(filepath.Join(absTarget, "data.db")); err != nil || !info.Mode().IsRegular() {
		return errors.New("restored backup has no regular data.db; target remains locked")
	}
	fmt.Printf(
		"backup extracted to %s; restore remains locked pending session invalidation and finalization (restore-id %s)\n",
		absTarget,
		*restoreID,
	)
	return nil
}

func extractBackup(backup, target string) (returnErr error) {
	archive, err := zip.OpenReader(backup)
	if err != nil {
		return err
	}
	defer func() { returnErr = errors.Join(returnErr, archive.Close()) }()
	for _, file := range archive.File {
		name := filepath.Clean(filepath.FromSlash(file.Name))
		if name == "." || filepath.IsAbs(name) || name == ".." ||
			strings.HasPrefix(name, ".."+string(filepath.Separator)) {
			return fmt.Errorf("unsafe backup path %q", file.Name)
		}
		if name == restoreMarkerName {
			return fmt.Errorf("backup must not contain the restore marker %q", file.Name)
		}
		if file.Mode()&os.ModeSymlink != 0 {
			return fmt.Errorf("backup symlinks are not allowed: %q", file.Name)
		}
		destination := filepath.Join(target, name)
		if file.FileInfo().IsDir() {
			if err := os.MkdirAll(destination, 0o700); err != nil {
				return err
			}
			continue
		}
		if err := os.MkdirAll(filepath.Dir(destination), 0o700); err != nil {
			return err
		}
		source, err := file.Open()
		if err != nil {
			return err
		}
		dest, err := os.OpenFile(destination, os.O_CREATE|os.O_EXCL|os.O_WRONLY, 0o600)
		if err != nil {
			return errors.Join(err, source.Close())
		}
		_, copyErr := io.Copy(dest, source)
		closeErr := errors.Join(dest.Close(), source.Close())
		if err := errors.Join(copyErr, closeErr); err != nil {
			return err
		}
	}
	return nil
}

func registerBackupCommand(app *pocketbase.PocketBase) {
	command := &cobra.Command{
		Use:   "backup-create [name]",
		Short: "Create a consistent PocketBase backup",
		Args:  cobra.MaximumNArgs(1),
		RunE: func(cmd *cobra.Command, args []string) error {
			name := ""
			if len(args) == 1 {
				name = args[0]
			}
			return app.CreateBackup(cmd.Context(), name)
		},
	}
	app.RootCmd.AddCommand(command)
}

func registerRestoreFinalizeCommand(app *pocketbase.PocketBase) {
	command := &cobra.Command{
		Use:   restoreFinalizeCommand,
		Short: "Invalidate restored sessions and unlock a restored data directory",
		Args:  cobra.NoArgs,
		RunE: func(cmd *cobra.Command, _ []string) error {
			if err := app.RunAllMigrations(); err != nil {
				return fmt.Errorf("apply restored database migrations: %w", err)
			}
			restoreID, _ := cmd.Flags().GetString("restore-id")
			return finalizeRestore(app, restoreID)
		},
	}
	command.Flags().String("restore-id", "", "external restore UUID")
	_ = command.MarkFlagRequired("restore-id")
	app.RootCmd.AddCommand(command)
}

func finalizeRestore(app core.App, restoreID string) error {
	if uuid.Validate(restoreID) != nil {
		return errors.New("restore-id must be a UUID")
	}
	markerID, markerErr := os.ReadFile(restoreMarker(app.DataDir()))
	if markerErr == nil && strings.TrimSpace(string(markerID)) != restoreID {
		return errors.New("restore-id does not match the pending restore marker")
	}
	if markerErr != nil && !errors.Is(markerErr, os.ErrNotExist) {
		return markerErr
	}

	var alreadyFinalized bool
	err := app.RunInTransaction(func(tx core.App) error {
		var count struct {
			Value int `db:"value"`
		}
		if err := tx.DB().NewQuery("SELECT COUNT(*) value FROM _todo_restore_runs WHERE restore_id={:id}").
			Bind(dbx.Params{"id": restoreID}).One(&count); err != nil {
			return err
		}
		if count.Value != 0 {
			alreadyFinalized = true
			return nil
		}
		if errors.Is(markerErr, os.ErrNotExist) {
			return errors.New("no pending restore marker found")
		}
		if _, err := tx.DB().NewQuery("UPDATE _todo_sync_state SET generation={:generation} WHERE id=1").
			Bind(dbx.Params{"generation": uuid.NewString()}).Execute(); err != nil {
			return err
		}
		for _, table := range []string{
			"_oauth_tokens", "_oauth_pending", "_oauth_refresh_replays", core.CollectionNameMFAs,
			core.CollectionNameOTPs, core.CollectionNameAuthOrigins,
		} {
			if _, err := tx.DB().NewQuery("DELETE FROM " + table).Execute(); err != nil {
				return err
			}
		}
		for _, collection := range []string{"todo_users", core.CollectionNameSuperusers} {
			records, err := tx.FindRecordsByFilter(collection, "", "", 0, 0)
			if err != nil {
				return err
			}
			for _, record := range records {
				record.RefreshTokenKey()
				if err := tx.Save(record); err != nil {
					return err
				}
			}
		}
		_, err := tx.DB().NewQuery("INSERT INTO _todo_restore_runs (restore_id, finalized) VALUES ({:id}, 1)").
			Bind(dbx.Params{"id": restoreID}).Execute()
		return err
	})
	if err != nil {
		return err
	}
	if err := os.Remove(restoreMarker(app.DataDir())); err != nil && !errors.Is(err, os.ErrNotExist) {
		return fmt.Errorf("restore was finalized but marker removal failed: %w", err)
	}
	if alreadyFinalized {
		fmt.Println("restore already finalized; pending marker cleared")
	} else {
		fmt.Println("restore finalized; sync generation and all authentication sessions rotated")
	}
	return nil
}
