package main

import (
	"bytes"
	"encoding/json"
	"fmt"
	"math"
	"net/http"
	"reflect"
	"regexp"
	"slices"
	"strconv"
	"strings"
	"time"

	"github.com/pocketbase/dbx"
	"github.com/pocketbase/pocketbase/apis"
	"github.com/pocketbase/pocketbase/core"
	"github.com/teambition/rrule-go"
)

type Object = map[string]any

func num(v any) float64 {
	n, _ := v.(float64)
	return n
}

func str(v any) string {
	s, _ := v.(string)
	return s
}

func obj(v any) Object {
	m, _ := v.(map[string]any)
	return m
}

func integer(v any, min float64) bool {
	n, ok := v.(float64)
	return ok && n >= min && n <= 9007199254740991 && math.Trunc(n) == n
}

var uuidPattern = regexp.MustCompile(`(?i)^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$`)
var rankPattern = regexp.MustCompile(`^[0-9a-f]{32}$`)
var recurrenceRulePattern = regexp.MustCompile(`^[A-Z]+=[A-Z0-9,+-]+(?:;[A-Z]+=[A-Z0-9,+-]+)*$`)

func isUUID(v any) bool { return uuidPattern.MatchString(str(v)) }

func bad(message string) error { return apis.NewBadRequestError(message, nil) }

func conflict(message string) error { return apis.NewApiError(409, message, nil) }

func canonical(v any) string {
	var b bytes.Buffer
	enc := json.NewEncoder(&b)
	enc.SetEscapeHTML(false)
	_ = enc.Encode(v)
	return strings.TrimSuffix(b.String(), "\n")
}

func sameJSON(a, b string) bool {
	var x, y any
	return json.Unmarshal([]byte(a), &x) == nil && json.Unmarshal([]byte(b), &y) == nil && reflect.DeepEqual(x, y)
}

func payload(row *core.Record) Object {
	var p Object
	_ = json.Unmarshal([]byte(row.GetString("data")), &p)
	return p
}

func find(app core.App, collection, filter string, params dbx.Params) (*core.Record, error) {
	rows, err := app.FindRecordsByFilter(collection, filter, "", 1, 0, params)
	if err != nil {
		return nil, err
	}
	if len(rows) == 0 {
		return nil, nil
	}
	return rows[0], nil
}

func entity(app core.App, owner, kind, id string) (Object, error) {
	r, err := find(app, kind+"s", "owner={:owner} && entityId={:id}", dbx.Params{"owner": owner, "id": id})
	if err != nil {
		return nil, err
	}
	if r == nil {
		return nil, apis.NewNotFoundError("Record not found", nil)
	}
	return payload(r), nil
}

func fields(kind string) []string {
	if kind == "list" {
		return []string{"name", "deletedAt", "rank"}
	}
	return []string{
		"title",
		"completed",
		"deletedAt",
		"rank",
		"dueDate",
		"plannedDate",
		"listId",
		"recurrenceRule",
		"recurrenceDate",
		"seriesId",
	}
}

func stamp(p Object, field string) Object {
	if s := obj(obj(p["fieldVersions"])[field]); s != nil {
		return s
	}
	n := float64(0)
	if p[field] != nil {
		n = num(p["version"])
	}
	return Object{"counter": n, "deviceId": ""}
}

func optional(field string) bool {
	return slices.Contains(
		[]string{"rank", "dueDate", "plannedDate", "listId", "recurrenceRule", "recurrenceDate", "seriesId"},
		field,
	)
}

func validRecurrenceRule(value any) bool {
	rule, ok := value.(string)
	if !ok || len(rule) == 0 || len(rule) > 512 || !recurrenceRulePattern.MatchString(rule) {
		return false
	}
	parts := strings.Split(rule, ";")
	seen := map[string]bool{}
	for _, part := range parts {
		key := strings.SplitN(part, "=", 2)[0]
		if seen[key] || slices.Contains([]string{"DTSTART", "COUNT", "UNTIL", "BYHOUR", "BYMINUTE", "BYSECOND"}, key) {
			return false
		}
		seen[key] = true
	}
	option, err := rrule.StrToROption(rule)
	if err != nil ||
		!slices.Contains([]rrule.Frequency{rrule.DAILY, rrule.WEEKLY, rrule.MONTHLY, rrule.YEARLY}, option.Freq) {
		return false
	}
	_, err = rrule.NewRRule(*option)
	return err == nil
}

func validCalendarDate(value any) bool {
	date, err := time.Parse("2006-01-02", str(value))
	return err == nil && date.Year() >= 1 && date.Format("2006-01-02") == str(value)
}

func validFields(p Object, kind string) bool {
	stamps := obj(p["fieldVersions"])
	if stamps == nil {
		return false
	}
	for k := range stamps {
		if !slices.Contains(fields(kind), k) {
			return false
		}
	}
	for _, f := range fields(kind) {
		s := obj(stamps[f])
		if s == nil {
			if optional(f) && p[f] == nil {
				continue
			}
			return false
		}
		_, deviceString := s["deviceId"].(string)
		if len(s) != 2 || !integer(s["counter"], 0) || num(s["counter"]) > num(p["version"]) || !deviceString ||
			(s["deviceId"] != "" && !isUUID(s["deviceId"])) {
			return false
		}
		if f == "deletedAt" && p[f] == nil {
			if num(s["counter"]) != 0 || s["deviceId"] != "" {
				return false
			}
		} else if optional(f) && p[f] == nil {
			if num(s["counter"]) == 0 && s["deviceId"] != "" {
				return false
			}
		} else if num(s["counter"]) == 0 {
			return false
		}
	}
	return true
}

func merge(a, b Object, kind string) (Object, error) {
	r := Object{}
	for k, v := range a {
		r[k] = v
	}
	stamps := Object{}
	r["fieldVersions"] = stamps
	r["version"] = math.Max(num(a["version"]), num(b["version"]))
	for _, f := range fields(kind) {
		x, y := stamp(a, f), stamp(b, f)
		order := num(x["counter"]) - num(y["counter"])
		if order == 0 {
			order = float64(strings.Compare(str(x["deviceId"]), str(y["deviceId"])))
		}
		if order == 0 && !reflect.DeepEqual(a[f], b[f]) {
			return nil, conflict("Field stamp reused with different value")
		}
		winner, s := a, x
		if order < 0 {
			winner, s = b, y
		}
		stamps[f] = s
		if v, ok := winner[f]; ok {
			r[f] = v
		} else {
			delete(r, f)
		}
	}
	if kind == "task" {
		r["createdAt"] = math.Min(num(a["createdAt"]), num(b["createdAt"]))
		r["updatedAt"] = math.Max(num(a["updatedAt"]), num(b["updatedAt"]))
	}
	return r, nil
}

func validateMutation(m Object, owner string) error {
	kind := str(m["entityType"])
	operation := str(m["operation"])
	p := obj(m["payload"])
	if !isUUID(m["id"]) || !isUUID(m["entityId"]) || !isUUID(m["deviceId"]) ||
		!slices.Contains([]string{"task", "list"}, kind) ||
		!slices.Contains([]string{"create", "update", "delete"}, operation) ||
		!integer(m["entityVersion"], 1) ||
		!integer(m["baseRevision"], 0) {
		return bad("Invalid mutation envelope")
	}
	if p == nil || p["ownerId"] != owner || p["id"] != m["entityId"] || p["version"] != m["entityVersion"] {
		return bad("Invalid payload identity")
	}
	allowed := append([]string{"id", "ownerId", "version", "remoteRevision", "fieldVersions"}, fields(kind)...)
	if kind == "task" {
		allowed = append(allowed, "createdAt", "updatedAt")
	}
	for k := range p {
		if !slices.Contains(allowed, k) {
			return bad("Unknown payload fields")
		}
	}
	d, deleted := p["deletedAt"]
	if deleted && !integer(d, 1) {
		return bad("Invalid tombstone")
	}
	if (operation == "delete") != deleted {
		return bad("Invalid delete operation")
	}
	if rank, exists := p["rank"]; exists &&
		(!rankPattern.MatchString(str(rank)) || rank == strings.Repeat("0", 32) || rank == strings.Repeat("f", 32)) {
		return bad("Invalid rank")
	}
	for _, f := range []string{"dueDate", "plannedDate", "recurrenceDate"} {
		if v := p[f]; v != nil {
			if !validCalendarDate(v) {
				return bad("Invalid calendar date")
			}
		}
	}
	if p["listId"] != nil && !isUUID(p["listId"]) {
		return bad("Invalid list id")
	}
	recurrenceValues := 0
	for _, field := range []string{"recurrenceRule", "recurrenceDate", "seriesId"} {
		if p[field] != nil {
			recurrenceValues++
		}
	}
	if recurrenceValues != 0 && recurrenceValues != 3 {
		return bad("Incomplete recurrence")
	}
	if recurrenceValues == 3 && (!validRecurrenceRule(p["recurrenceRule"]) || !isUUID(p["seriesId"])) {
		return bad("Invalid recurrence")
	}
	name := p["name"]
	if kind == "task" {
		name = p["title"]
		if _, ok := p["completed"].(bool); !ok || !integer(p["createdAt"], 0) || !integer(p["updatedAt"], 0) {
			return bad("Invalid task")
		}
	}
	if strings.TrimSpace(str(name)) == "" || len([]rune(str(name))) > 2000 {
		return bad("Invalid title or name")
	}
	if _, ok := p["fieldVersions"]; ok && !validFields(p, kind) {
		return bad("Invalid field versions")
	}
	return nil
}

func clock(app core.App) (int64, error) {
	var r struct {
		Value int64 `db:"value"`
	}
	err := app.DB().NewQuery("SELECT value FROM _todo_clock WHERE id=1").One(&r)
	return r.Value, err
}

func syncGeneration(app core.App) (string, error) {
	var row struct {
		Generation string `db:"generation"`
	}
	err := app.DB().NewQuery("SELECT generation FROM _todo_sync_state WHERE id=1").One(&row)
	return row.Generation, err
}

type snapshotRow struct {
	EntityID string `db:"entityId"`
	Data     string `db:"data"`
}

func snapshotRecords(app core.App, owner, kind, after string, until int64, limit int) ([]Object, string, bool, error) {
	rows := []snapshotRow{}
	err := app.DB().NewQuery(`
		SELECT c.entityId, c.data
		FROM todo_changes c
		JOIN (
			SELECT entityId, MAX(revision) AS revision
			FROM todo_changes
			WHERE owner={:owner} AND kind={:kind} AND revision<={:until} AND entityId>{:after}
			GROUP BY entityId
		) latest ON latest.entityId=c.entityId AND latest.revision=c.revision
		WHERE c.owner={:owner} AND c.kind={:kind}
		ORDER BY c.entityId
		LIMIT {:limit}
	`).Bind(dbx.Params{
		"owner": owner, "kind": kind, "until": until, "after": after, "limit": limit + 1,
	}).All(&rows)
	if err != nil {
		return nil, "", false, err
	}
	more := len(rows) > limit
	if more {
		rows = rows[:limit]
	}
	records := make([]Object, 0, len(rows))
	for _, row := range rows {
		var record Object
		if err := json.Unmarshal([]byte(row.Data), &record); err != nil {
			return nil, "", false, err
		}
		records = append(records, record)
	}
	cursor := ""
	if more && len(rows) > 0 {
		cursor = rows[len(rows)-1].EntityID
	}
	return records, cursor, more, nil
}

func applyMutation(app core.App, owner string, m Object, identity string) (Object, error) {
	if err := validateMutation(m, owner); err != nil {
		return nil, err
	}
	if identity == "" {
		identity = canonical(m)
	}
	receipt, err := find(
		app,
		"todo_receipts",
		"owner={:owner} && mutationId={:id}",
		dbx.Params{"owner": owner, "id": m["id"]},
	)
	if err != nil {
		return nil, err
	}
	if receipt != nil {
		if !sameJSON(receipt.GetString("request"), identity) {
			return nil, conflict("Idempotency key reused with different payload")
		}
		var ack Object
		err = json.Unmarshal([]byte(receipt.GetString("ack")), &ack)
		return ack, err
	}
	kind := str(m["entityType"])
	p := obj(m["payload"])
	row, err := find(app, kind+"s", "owner={:owner} && entityId={:id}", dbx.Params{"owner": owner, "id": m["entityId"]})
	if err != nil {
		return nil, err
	}
	if row != nil {
		current := payload(row)
		if p["fieldVersions"] != nil {
			p, err = merge(current, p, kind)
			if err != nil {
				return nil, err
			}
		} else {
			if current["fieldVersions"] != nil {
				return nil, conflict("Legacy mutation requires reconciliation before field-versioned data")
			}
			if num(m["baseRevision"]) != float64(row.GetInt("revision")) &&
				!(m["deviceId"] == row.GetString("deviceId") && num(m["entityVersion"]) > float64(row.GetInt("clientVersion"))) {
				return nil, conflict("Legacy concurrent edit; local change remains pending")
			}
			if current["deletedAt"] != nil && p["deletedAt"] == nil {
				return nil, conflict("Deleted records cannot be restored")
			}
		}
	} else {
		if num(m["baseRevision"]) != 0 {
			return nil, conflict("Unknown base revision")
		}
		c, err := app.FindCollectionByNameOrId(kind + "s")
		if err != nil {
			return nil, err
		}
		row = core.NewRecord(c)
	}
	if _, err = app.DB().NewQuery("UPDATE _todo_clock SET value=value+1 WHERE id=1").Execute(); err != nil {
		return nil, err
	}
	revision, err := clock(app)
	if err != nil {
		return nil, err
	}
	if revision > 9007199254740991 {
		return nil, fmt.Errorf("revision overflow")
	}
	p["ownerId"] = owner
	p["remoteRevision"] = float64(revision)
	row.Load(
		Object{
			"owner":         owner,
			"entityId":      m["entityId"],
			"data":          p,
			"revision":      revision,
			"deviceId":      m["deviceId"],
			"clientVersion": m["entityVersion"],
		},
	)
	if err = app.Save(row); err != nil {
		return nil, err
	}
	c, err := app.FindCollectionByNameOrId("todo_changes")
	if err != nil {
		return nil, err
	}
	change := core.NewRecord(c)
	change.Load(Object{"owner": owner, "kind": kind, "entityId": m["entityId"], "revision": revision, "data": p})
	if err = app.Save(change); err != nil {
		return nil, err
	}
	ack := Object{
		"mutationId":     m["id"],
		"entityId":       m["entityId"],
		"entityType":     kind,
		"entityVersion":  m["entityVersion"],
		"serverRevision": float64(revision),
	}
	c, err = app.FindCollectionByNameOrId("todo_receipts")
	if err != nil {
		return nil, err
	}
	saved := core.NewRecord(c)
	saved.Load(Object{"owner": owner, "mutationId": m["id"], "request": identity, "ack": ack})
	return ack, app.Save(saved)
}

func registerTodo(e *core.ServeEvent) {
	e.Router.POST("/api/todo/push", func(r *core.RequestEvent) error {
		generation, err := syncGeneration(r.App)
		if err != nil {
			return err
		}
		if r.Request.Header.Get("X-Todo-Sync-Generation") != generation {
			return conflict("Sync generation changed; reset from a snapshot")
		}
		var m Object
		if err := r.BindBody(&m); err != nil {
			return bad("Invalid JSON")
		}
		var ack Object
		err = r.App.RunInTransaction(
			func(tx core.App) error { var err error; ack, err = applyMutation(tx, r.Auth.Id, m, ""); return err },
		)
		if err != nil {
			return err
		}
		return r.JSON(200, ack)
	}).Bind(apis.RequireAuth("todo_users"), apis.BodyLimit(65536))
	e.Router.GET("/api/todo/pull", func(r *core.RequestEvent) error {
		current, err := clock(r.App)
		if err != nil {
			return err
		}
		q := r.Request.URL.Query()
		generation, err := syncGeneration(r.App)
		if err != nil {
			return err
		}
		if q.Get("generation") != generation {
			return r.JSON(http.StatusOK, Object{"mode": "reset", "generation": generation, "until": current})
		}
		parse := func(key string, fallback int64) (int64, error) {
			if q.Get(key) == "" {
				return fallback, nil
			}
			v, err := strconv.ParseInt(q.Get(key), 10, 64)
			if err != nil || v < 0 {
				return 0, bad("Invalid cursor")
			}
			return v, nil
		}
		after, err := parse("after", 0)
		if err != nil {
			return err
		}
		until, err := parse("until", current)
		if err != nil {
			return err
		}
		limit, err := parse("limit", 50)
		if err != nil {
			return err
		}
		if after > until || until > current || limit < 1 || limit > 100 {
			return bad("Invalid paging bounds")
		}
		rows, err := r.App.FindRecordsByFilter(
			"todo_changes",
			"owner={:owner} && revision>{:after} && revision<={:until}",
			"revision",
			int(limit)+1,
			0,
			dbx.Params{"owner": r.Auth.Id, "after": after, "until": until},
		)
		if err != nil {
			return err
		}
		more := len(rows) > int(limit)
		if more {
			rows = rows[:limit]
		}
		changes := []Object{}
		for _, row := range rows {
			changes = append(
				changes,
				Object{
					"revision":   row.GetInt("revision"),
					"entityType": row.GetString("kind"),
					"entityId":   row.GetString("entityId"),
					"payload":    payload(row),
				},
			)
		}
		cursor := until
		if more {
			cursor = int64(rows[len(rows)-1].GetInt("revision"))
		}
		return r.JSON(http.StatusOK, Object{
			"mode": "changes", "generation": generation, "changes": changes,
			"until": until, "cursor": cursor, "hasMore": more,
		})
	}).Bind(apis.RequireAuth("todo_users"))
	e.Router.GET("/api/todo/snapshot", func(r *core.RequestEvent) error {
		q := r.Request.URL.Query()
		generation, err := syncGeneration(r.App)
		if err != nil {
			return err
		}
		if q.Get("generation") != generation {
			return conflict("Sync generation changed; restart snapshot")
		}
		kind := q.Get("kind")
		if kind != "list" && kind != "task" {
			return bad("Invalid snapshot kind")
		}
		current, err := clock(r.App)
		if err != nil {
			return err
		}
		parseRequired := func(key string) (int64, error) {
			v, err := strconv.ParseInt(q.Get(key), 10, 64)
			if err != nil || v < 0 {
				return 0, bad("Invalid snapshot bounds")
			}
			return v, nil
		}
		until, err := parseRequired("until")
		if err != nil {
			return err
		}
		limit := int64(50)
		if q.Get("limit") != "" {
			limit, err = parseRequired("limit")
			if err != nil {
				return err
			}
		}
		after := q.Get("after")
		if until > current || limit < 1 || limit > 100 || (after != "" && !uuidPattern.MatchString(after)) {
			return bad("Invalid snapshot bounds")
		}
		records, cursor, more, err := snapshotRecords(r.App, r.Auth.Id, kind, after, until, int(limit))
		if err != nil {
			return err
		}
		return r.JSON(http.StatusOK, Object{
			"generation": generation, "until": until, "kind": kind,
			"records": records, "cursor": cursor, "hasMore": more,
		})
	}).Bind(apis.RequireAuth("todo_users"))
}
