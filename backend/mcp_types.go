package main

import (
	"context"
	"encoding/json"
	"reflect"
	"slices"
	"strings"

	"github.com/google/jsonschema-go/jsonschema"
	"github.com/modelcontextprotocol/go-sdk/mcp"
	"github.com/pocketbase/pocketbase/core"
)

type EntityID string
type TaskText string
type PageLimit int
type Revision int64

type PageInput struct {
	Limit  PageLimit `json:"limit,omitempty"`
	Cursor EntityID  `json:"cursor,omitempty"`
}

type ListTasksInput struct {
	PageInput
	Completed *bool     `json:"completed,omitempty"`
	ListID    *EntityID `json:"listId,omitempty"`
	Query     TaskText  `json:"query,omitempty"`
}

type GetTaskInput struct {
	ID EntityID `json:"id"`
}

type CreateTaskInput struct {
	MutationID     EntityID  `json:"mutationId"               jsonschema:"New UUID per intended write; reuse identical arguments when retrying."`
	Title          TaskText  `json:"title"`
	Completed      bool      `json:"completed,omitempty"`
	DueDate        *string   `json:"dueDate,omitempty"        jsonschema:"Calendar date YYYY-MM-DD, or null."`
	PlannedDate    *string   `json:"plannedDate,omitempty"    jsonschema:"Calendar date YYYY-MM-DD, or null."`
	ListID         *EntityID `json:"listId,omitempty"`
	RecurrenceRule *string   `json:"recurrenceRule,omitempty" jsonschema:"Bare date-level RRULE, supplied together with recurrenceDate and seriesId."`
	RecurrenceDate *string   `json:"recurrenceDate,omitempty" jsonschema:"Current occurrence date YYYY-MM-DD."`
	SeriesID       *EntityID `json:"seriesId,omitempty"`
}

type TaskMutationInput struct {
	MutationID       EntityID `json:"mutationId"       jsonschema:"New UUID per intended write; reuse identical arguments when retrying."`
	ID               EntityID `json:"id"`
	ExpectedRevision Revision `json:"expectedRevision" jsonschema:"remoteRevision from the latest read; stale revisions are rejected."`
}

type TaskChanges struct {
	Title          TaskText  `json:"title,omitempty"`
	Completed      bool      `json:"completed,omitempty"`
	DueDate        *string   `json:"dueDate,omitempty"`
	PlannedDate    *string   `json:"plannedDate,omitempty"`
	ListID         *EntityID `json:"listId,omitempty"`
	RecurrenceRule *string   `json:"recurrenceRule,omitempty"`
	RecurrenceDate *string   `json:"recurrenceDate,omitempty"`
	SeriesID       *EntityID `json:"seriesId,omitempty"`
}

type UpdateTaskInput struct {
	TaskMutationInput
	Changes TaskChanges `json:"changes"`
}

type CreateListInput struct {
	MutationID EntityID `json:"mutationId"`
	Name       TaskText `json:"name"`
}

func pointer[T any](v T) *T { return &v }

func inputSchema[T any]() *jsonschema.Schema {
	schema, err := jsonschema.For[T](&jsonschema.ForOptions{TypeSchemas: map[reflect.Type]*jsonschema.Schema{
		reflect.TypeFor[EntityID]():  {Type: "string", Pattern: uuidPattern.String()},
		reflect.TypeFor[TaskText]():  {Type: "string", MinLength: pointer(1), MaxLength: pointer(2000), Pattern: `\S`},
		reflect.TypeFor[PageLimit](): {Type: "integer", Minimum: pointer(1.0), Maximum: pointer(100.0)},
		reflect.TypeFor[Revision]():  {Type: "integer", Minimum: pointer(1.0), Maximum: pointer(9007199254740991.0)},
	}})
	if err != nil {
		panic(err)
	}
	if changes := schema.Properties["changes"]; changes != nil {
		changes.MinProperties = pointer(1)
	}
	return schema
}

func registerTool[In any](server *mcp.Server, app core.App, name, description string, readOnly, destructive bool) {
	tool := &mcp.Tool{
		Name:        name,
		Description: description,
		InputSchema: inputSchema[In](),
		Annotations: &mcp.ToolAnnotations{
			ReadOnlyHint: readOnly, DestructiveHint: &destructive, IdempotentHint: true, OpenWorldHint: pointer(false),
		},
	}
	mcp.AddTool(
		server,
		tool,
		func(ctx context.Context, req *mcp.CallToolRequest, _ In) (*mcp.CallToolResult, Object, error) {
			p, _ := ctx.Value(principalKey{}).(principal)
			needed := "tasks:write"
			if readOnly {
				needed = "tasks:read"
			}
			if !slices.Contains(strings.Fields(p.Scope), needed) {
				return nil, nil, bad("Insufficient scope")
			}
			// The SDK validates against the inferred struct schema. Preserve raw field presence:
			// omitted patches leave values unchanged, while explicit null clears dates and lists.
			var args Object
			if err := json.Unmarshal(req.Params.Arguments, &args); err != nil {
				return nil, nil, err
			}
			result, err := callTool(app, p.Owner, name, args)
			return nil, result, err
		},
	)
}
