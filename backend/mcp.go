package main

import (
	"encoding/json"
	"fmt"
	"math"
	"math/big"
	"net/http"
	"strings"
	"time"

	"github.com/google/uuid"
	"github.com/modelcontextprotocol/go-sdk/mcp"
	"github.com/pocketbase/dbx"
	"github.com/pocketbase/pocketbase/core"
	"github.com/teambition/rrule-go"
)

type principal struct{ Owner, Scope string }
type principalKey struct{}

func appendRank(app core.App, owner, kind string) (string, error) {
	rows, err := app.FindRecordsByFilter(
		kind+"s",
		"owner={:owner} && data.deletedAt = null && data.rank != null",
		"-data.rank",
		1,
		0,
		dbx.Params{"owner": owner},
	)
	if err != nil {
		return "", err
	}
	lower := new(big.Int)
	if len(rows) > 0 {
		lower.SetString(str(payload(rows[0])["rank"]), 16)
	}
	max, _ := new(big.Int).SetString(strings.Repeat("f", 32), 16)
	mid := new(big.Int).Rsh(new(big.Int).Add(lower, max), 1)
	if mid.Cmp(lower) == 0 {
		return "", bad("Rank space exhausted; reorder in app first")
	}
	return fmt.Sprintf("%032x", mid), nil
}

func shiftedDate(value any, days int) any {
	if value == nil {
		return nil
	}
	date, _ := time.Parse("2006-01-02", str(value))
	return date.AddDate(0, 0, days).Format("2006-01-02")
}

func nextRecurrenceDate(rule, current string) (string, error) {
	option, err := rrule.StrToROption(rule)
	if err != nil {
		return "", err
	}
	date, err := time.Parse("2006-01-02", current)
	if err != nil {
		return "", err
	}
	option.Dtstart = date
	r, err := rrule.NewRRule(*option)
	if err != nil {
		return "", err
	}
	next := r.After(date, false)
	if next.IsZero() {
		return "", fmt.Errorf("recurrence has no next occurrence")
	}
	return next.Format("2006-01-02"), nil
}

func createRecurringSuccessor(app core.App, owner string, completed Object, device string, now float64) error {
	currentDate := str(completed["recurrenceDate"])
	nextDate, err := nextRecurrenceDate(str(completed["recurrenceRule"]), currentDate)
	if err != nil {
		return err
	}
	current, _ := time.Parse("2006-01-02", currentDate)
	next, _ := time.Parse("2006-01-02", nextDate)
	days := int(next.Sub(current).Hours() / 24)
	series := uuid.MustParse(str(completed["seriesId"]))
	id := uuid.NewSHA1(series, []byte(nextDate)).String()
	rank, err := appendRank(app, owner, "task")
	if err != nil {
		return err
	}
	p := Object{
		"id":             id,
		"ownerId":        owner,
		"version":        float64(1),
		"title":          completed["title"],
		"description":    completed["description"],
		"completed":      false,
		"rank":           rank,
		"dueDate":        shiftedDate(completed["dueDate"], days),
		"plannedDate":    shiftedDate(completed["plannedDate"], days),
		"listId":         completed["listId"],
		"recurrenceRule": completed["recurrenceRule"],
		"recurrenceDate": nextDate,
		"seriesId":       completed["seriesId"],
		"createdAt":      now,
		"updatedAt":      now,
	}
	stamps := Object{}
	for _, field := range fields("task") {
		if p[field] == nil {
			stamps[field] = Object{"counter": float64(0), "deviceId": ""}
		} else {
			stamps[field] = Object{"counter": float64(1), "deviceId": device}
		}
	}
	p["fieldVersions"] = stamps
	mutationID := uuid.NewSHA1(series, []byte("mcp-successor:"+nextDate)).String()
	mutation := Object{
		"id":            mutationID,
		"entityId":      id,
		"entityType":    "task",
		"entityVersion": float64(1),
		"operation":     "create",
		"deviceId":      device,
		"baseRevision":  float64(0),
		"payload":       p,
	}
	_, err = applyMutation(app, owner, mutation, canonical(Object{
		"source": "mcp-recurrence", "seriesId": completed["seriesId"], "recurrenceDate": nextDate,
	}))
	return err
}

// stampChanges applies changes to p and bumps the field version of every field
// the mutation actually touched. It returns the entity version for the mutation.
func stampChanges(p, changes Object, kind string, create bool, device string) float64 {
	stamps := Object{}
	counter := num(p["version"])
	for _, f := range fields(kind) {
		s := stamp(p, f)
		stamps[f] = s
		counter = math.Max(counter, num(s["counter"]))
	}
	counter++
	for k, v := range changes {
		p[k] = v
	}
	for _, f := range fields(kind) {
		_, changed := changes[f]
		if (create && p[f] != nil) || (!create && changed) {
			stamps[f] = Object{"counter": counter, "deviceId": device}
		}
	}
	p["version"] = counter
	p["fieldVersions"] = stamps
	return counter
}

// detachListTasks mirrors the app: deleting a list either tombstones its active
// tasks or keeps them without a list. Every task becomes its own mutation, with
// a mutation ID derived from the caller's, so a retry stays idempotent.
func detachListTasks(tx core.App, owner string, a, list Object, device string, now float64) error {
	base, err := uuid.Parse(str(a["mutationId"]))
	if err != nil {
		return err
	}
	remove, _ := a["deleteTasks"].(bool)
	rows, err := tx.FindRecordsByFilter(
		"tasks",
		"owner={:owner} && data.deletedAt = null && data.listId = {:list}",
		"entityId",
		0,
		0,
		dbx.Params{"owner": owner, "list": list["id"]},
	)
	if err != nil {
		return err
	}
	for _, row := range rows {
		task := payload(row)
		changes := Object{"listId": nil}
		operation := "update"
		if remove {
			changes = Object{"deletedAt": now}
			operation = "delete"
		}
		version := stampChanges(task, changes, "task", false, device)
		task["updatedAt"] = now
		if _, err := applyMutation(tx, owner, Object{
			"id":            uuid.NewSHA1(base, []byte("list-delete:"+str(task["id"]))).String(),
			"entityId":      task["id"],
			"entityType":    "task",
			"entityVersion": version,
			"operation":     operation,
			"deviceId":      device,
			"baseRevision":  num(task["remoteRevision"]),
			"payload":       task,
		}, ""); err != nil {
			return err
		}
	}
	return nil
}

func callTool(app core.App, owner, name string, a Object) (Object, error) {
	if name == "get_task" {
		p, err := entity(app, owner, "task", str(a["id"]))
		return Object{"entity": p}, err
	}
	if name == "list_tasks" || name == "list_lists" {
		kind := "task"
		if name == "list_lists" {
			kind = "list"
		}
		clauses := []string{"owner={:owner}", "data.deletedAt = null"}
		params := dbx.Params{"owner": owner}
		for key, clause := range map[string]string{"cursor": "entityId > {:cursor}", "completed": "data.completed = {:completed}", "listId": "data.listId = {:listId}", "query": "(data.title ~ {:query} || data.description ~ {:query})"} {
			if v, ok := a[key]; ok {
				if key == "listId" && v == nil {
					clause = "data.listId = null"
				}
				clauses = append(clauses, clause)
				params[key] = v
			}
		}
		limit := 50
		if a["limit"] != nil {
			limit = int(num(a["limit"]))
		}
		rows, err := app.FindRecordsByFilter(kind+"s", strings.Join(clauses, " && "), "entityId", limit+1, 0, params)
		if err != nil {
			return nil, err
		}
		var cursor any
		items := []Object{}
		for i, row := range rows {
			if i == limit {
				cursor = rows[i-1].GetString("entityId")
				break
			}
			items = append(items, payload(row))
		}
		return Object{"items": items, "nextCursor": cursor}, nil
	}
	var result Object
	err := app.RunInTransaction(func(tx core.App) error {
		identity := canonical(Object{"source": "mcp", "name": name, "arguments": a})
		previous, err := find(
			tx,
			"todo_receipts",
			"owner={:owner} && mutationId={:id}",
			dbx.Params{"owner": owner, "id": a["mutationId"]},
		)
		if err != nil {
			return err
		}
		if previous != nil {
			if !sameJSON(previous.GetString("request"), identity) {
				return conflict("Idempotency key reused with different arguments")
			}
			var ack Object
			if err = json.Unmarshal([]byte(previous.GetString("ack")), &ack); err != nil {
				return err
			}
			change, err := find(
				tx,
				"todo_changes",
				"owner={:owner} && revision={:revision}",
				dbx.Params{"owner": owner, "revision": ack["serverRevision"]},
			)
			if err != nil {
				return err
			}
			if change == nil {
				return fmt.Errorf("missing mutation history")
			}
			result = Object{"entity": payload(change), "revision": ack["serverRevision"]}
			return nil
		}
		create := name == "create_task" || name == "create_list"
		kind := "task"
		if name == "create_list" || name == "delete_list" {
			kind = "list"
		}
		noun := "Task"
		if kind == "list" {
			noun = "List"
		}
		now := float64(time.Now().UnixMilli())
		device := "00000000-0000-4000-8000-000000000001"
		var p Object
		if create {
			rank, err := appendRank(tx, owner, kind)
			if err != nil {
				return err
			}
			p = Object{"id": uuid.NewString(), "ownerId": owner, "version": float64(0), "rank": rank}
			if kind == "task" {
				for k, v := range (Object{"title": a["title"], "description": nil, "completed": false, "dueDate": nil, "plannedDate": nil, "listId": nil, "createdAt": now, "updatedAt": now}) {
					p[k] = v
				}
			} else {
				p["name"] = a["name"]
			}
		} else {
			p, err = entity(tx, owner, kind, str(a["id"]))
			if err != nil {
				return err
			}
			if p["remoteRevision"] != a["expectedRevision"] {
				return conflict(noun + " changed since it was read; fetch the current revision")
			}
			if p["deletedAt"] != nil {
				return conflict("Deleted " + strings.ToLower(noun) + "s cannot be edited")
			}
		}
		wasCompleted, _ := p["completed"].(bool)
		changes := Object{}
		switch name {
		case "create_task":
			for k, v := range a {
				if k != "mutationId" {
					changes[k] = v
				}
			}
		case "create_list":
			changes["name"] = a["name"]
		case "complete_task":
			changes["completed"] = true
		case "delete_task", "delete_list":
			changes["deletedAt"] = now
		default:
			changes = obj(a["changes"])
		}
		if list := changes["listId"]; list != nil {
			l, err := entity(tx, owner, "list", str(list))
			if err != nil {
				return err
			}
			if l["deletedAt"] != nil {
				return bad("List is deleted")
			}
		}
		counter := stampChanges(p, changes, kind, create, device)
		if kind == "task" {
			p["updatedAt"] = now
		}
		op := "update"
		if create {
			op = "create"
		}
		if name == "delete_task" || name == "delete_list" {
			op = "delete"
		}
		ack, err := applyMutation(
			tx,
			owner,
			Object{
				"id":            a["mutationId"],
				"entityId":      p["id"],
				"entityType":    kind,
				"entityVersion": counter,
				"operation":     op,
				"deviceId":      device,
				"baseRevision":  num(p["remoteRevision"]),
				"payload":       p,
			},
			identity,
		)
		if err != nil {
			return err
		}
		if name == "delete_list" {
			if err := detachListTasks(tx, owner, a, p, device, now); err != nil {
				return err
			}
		}
		if name == "complete_task" && !wasCompleted && p["recurrenceRule"] != nil {
			if err := createRecurringSuccessor(tx, owner, p, device, now); err != nil {
				return err
			}
		}
		p, err = entity(tx, owner, kind, str(p["id"]))
		result = Object{"entity": p, "revision": ack["serverRevision"]}
		return err
	})
	return result, err
}
func newMCP(app core.App) http.Handler {
	server := mcp.NewServer(&mcp.Implementation{Name: "todo-pocketbase", Version: "1.0.0"}, nil)
	registerTool[ListTasksInput](
		server,
		app,
		"list_tasks",
		"List active tasks, ordered by ID. Unsynced device edits are not included.",
		true,
		false,
	)
	registerTool[GetTaskInput](
		server,
		app,
		"get_task",
		"Read a task, including its remoteRevision and any deletion tombstone.",
		true,
		false,
	)
	registerTool[CreateTaskInput](
		server,
		app,
		"create_task",
		"Create a task through the normal sync log.",
		false,
		false,
	)
	registerTool[UpdateTaskInput](
		server,
		app,
		"update_task",
		"Update supplied fields. Null clears dates or a list. Read the current revision first.",
		false,
		true,
	)
	registerTool[TaskMutationInput](
		server,
		app,
		"complete_task",
		"Mark a task completed. Read the current revision first.",
		false,
		false,
	)
	registerTool[TaskMutationInput](
		server,
		app,
		"delete_task",
		"Delete a task using a sync tombstone. There is no restore command.",
		false,
		true,
	)
	registerTool[PageInput](server, app, "list_lists", "List active lists, ordered by ID.", true, false)
	registerTool[CreateListInput](
		server,
		app,
		"create_list",
		"Create a list through the normal sync log.",
		false,
		false,
	)
	registerTool[DeleteListInput](
		server,
		app,
		"delete_list",
		"Delete a list using a sync tombstone. Its tasks stay and lose the list unless deleteTasks is true. There is no restore command.",
		false,
		true,
	)
	return mcp.NewStreamableHTTPHandler(
		func(*http.Request) *mcp.Server { return server },
		&mcp.StreamableHTTPOptions{Stateless: true, JSONResponse: true},
	)
}
