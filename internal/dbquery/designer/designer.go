// Package designer defines object-designer DDL generators per dialect.
// Phase 1 ships only the interface + IR; concrete implementations land
// in sub-project B's plan.
package designer

import "context"

// Designer renders DDL for a database object IR. Returned SQL is dialect-
// specific; callers MUST run it through the existing safety gate before
// execution.
type Designer interface {
	RenderTable(ctx context.Context, spec TableSpec) (string, error)
	RenderView(ctx context.Context, spec ViewSpec) (string, error)
	RenderFunction(ctx context.Context, spec FunctionSpec) (string, error)
	RenderProcedure(ctx context.Context, spec ProcedureSpec) (string, error)
	RenderTrigger(ctx context.Context, spec TriggerSpec) (string, error)
	RenderEvent(ctx context.Context, spec EventSpec) (string, error)
	RenderIndex(ctx context.Context, spec IndexSpec) (string, error)
	RenderSequence(ctx context.Context, spec SequenceSpec) (string, error)
	Diff(ctx context.Context, oldSpec, newSpec any) ([]Change, error)
}

// Change is a single DDL operation produced by Diff.
type Change struct {
	Op      ChangeOp
	Kind    string // "table.column", "table.index", "table.fk", "view", ...
	Element string // human-readable element id
	SQL     string
	// NonTransactional flags engines where this op cannot be rolled back
	// (e.g. MySQL ALTER TABLE on InnoDB before 8.0.29).
	NonTransactional bool
}

type ChangeOp string

const (
	ChangeAdd    ChangeOp = "add"
	ChangeDrop   ChangeOp = "drop"
	ChangeModify ChangeOp = "modify"
)

// TableSpec is the IR for a relational table.
type TableSpec struct {
	Schema      string
	Name        string
	Columns     []ColumnSpec
	PrimaryKey  []string
	Indexes     []IndexSpec
	ForeignKeys []ForeignKeySpec
	Triggers    []TriggerSpec
	Engine      string // MySQL: InnoDB; PG: ignored
	Charset     string
	Collation   string
	Comment     string
	Options     map[string]string
}

type ColumnSpec struct {
	Name          string
	DataType      string
	Nullable      bool
	Default       *string // nil = no default
	AutoIncrement bool
	Comment       string
	GeneratedExpr string // computed columns
}

type IndexSpec struct {
	Name    string
	Columns []string
	Unique  bool
	Method  string // BTREE / HASH / GIN / ...
	Where   string // partial index condition
	Comment string
}

type ForeignKeySpec struct {
	Name       string
	Columns    []string
	RefSchema  string
	RefTable   string
	RefColumns []string
	OnUpdate   string // CASCADE / SET NULL / RESTRICT / NO ACTION
	OnDelete   string
}

type ViewSpec struct {
	Schema       string
	Name         string
	Definition   string // raw SELECT
	OrReplace    bool
	Materialized bool
}

type FunctionSpec struct {
	Schema     string
	Name       string
	Args       []ArgSpec
	ReturnType string
	Language   string
	Body       string
	Options    map[string]string
}

type ProcedureSpec struct {
	Schema   string
	Name     string
	Args     []ArgSpec
	Language string
	Body     string
	Options  map[string]string
}

type ArgSpec struct {
	Name     string
	DataType string
	Mode     string // IN / OUT / INOUT
}

type TriggerSpec struct {
	Schema  string
	Name    string
	Table   string
	Timing  string   // BEFORE / AFTER / INSTEAD OF
	Events  []string // INSERT / UPDATE / DELETE
	ForEach string   // ROW / STATEMENT
	When    string   // condition
	Body    string
}

type EventSpec struct {
	Schema     string
	Name       string
	Schedule   string // CRON-ish or AT/EVERY
	OnComplete string // PRESERVE / NOT PRESERVE
	Body       string
}

type SequenceSpec struct {
	Schema    string
	Name      string
	Start     int64
	Increment int64
	MinValue  *int64
	MaxValue  *int64
	Cache     int64
	Cycle     bool
}
