// Package completion defines the schema-aware autocomplete contract.
// Frontend's Monaco provider consumes Snapshot via the schema-cache.
package completion

import "context"

type Provider interface {
	// Snapshot returns a flat schema snapshot scoped to the database.
	// Callers cache it (TTL ~5min); DDL changes invalidate.
	Snapshot(ctx context.Context, database string) (Snapshot, error)
	// Keywords returns reserved keywords + bundled identifiers.
	Keywords(ctx context.Context) []string
}

type Snapshot struct {
	Database  string
	Schemas   []string
	Tables    []TableEntry
	Functions []FunctionEntry
	UpdatedAt int64 // unix seconds
}

type TableEntry struct {
	Schema  string
	Name    string
	Kind    string // table / view / matview
	Columns []ColumnEntry
}

type ColumnEntry struct {
	Name     string
	DataType string
	Nullable bool
}

type FunctionEntry struct {
	Schema     string
	Name       string
	ArgTypes   []string
	ReturnType string
}
