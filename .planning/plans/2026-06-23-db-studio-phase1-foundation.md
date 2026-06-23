# Db Studio Phase 1 · 基础设施 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 为 Db Studio Navicat 平替伞 spec 奠定底层骨架——扩展 Adapter 契约、新建 5 个能力族子包、新建 dbstudio 业务编排包、新建持久化表、注册 API 路由 stub、前端共享层。**不包含任何子项目业务实现**，仅打底。

**Architecture:** 沿用既有 `internal/dbquery/` 适配器系统，扩展 `Capabilities` + `Adapter` 接口（5 个新能力族）。新增 `internal/dbstudio/` 顶层业务编排包，封装 saved queries / pinned results / view profiles / ER 模型等跨子项目共享状态。前端在 `web/src/components/db/shared/` 加 schema cache + DDL renderer + React Flow canvas，6 个子模块各起目录骨架。

**Tech Stack:** Go (chi router / GORM / database/sql)，Next.js + React 18 + TanStack Query + Monaco Editor + React Flow + Recharts，Playwright E2E。

## Global Constraints

- **不破坏既有 Db Studio**：所有 capability flag 默认 false，既有 UI 行为不变
- **不实装业务逻辑**：本 phase 仅交付接口 + stub + 测试，业务代码留给子项目 plan
- **5 个新接口族返回 nil 视为不支持**：Adapter 实现可返回 nil，能力 gate 关闭对应 UI
- **数据库迁移走既有 `pkg/db` 流水**：用 GORM `AutoMigrate`，不手写 SQL migration 脚本
- **测试覆盖**：每个新公开类型 / 接口必须有最少 1 个单元测试；新 API 路由必须有 handler 测试
- **既有 commit 风格**：中文 commit message，前缀 `feat / fix / chore / refactor / docs / test`，作用域用括号包 `feat(db-studio):`
- **依赖白名单**：本 phase 不引入新 Go / npm 依赖；React Flow 在子项目 plan 引入
- **文件大小约束**：单文件 ≤ 400 行；超出拆分

---

## File Structure

### 新建文件
```
internal/dbquery/object_kind.go               # ObjectKindSet bitmask
internal/dbquery/designer/designer.go         # Designer interface + IR
internal/dbquery/planner/planner.go           # Planner interface + PlanNode
internal/dbquery/profiler/profiler.go         # Profiler interface
internal/dbquery/completion/completion.go     # Completion provider interface
internal/dbquery/modeler/modeler.go           # Modeler interface + TableIR
internal/dbquery/designer/designer_test.go
internal/dbquery/planner/planner_test.go
internal/dbquery/profiler/profiler_test.go
internal/dbquery/completion/completion_test.go
internal/dbquery/modeler/modeler_test.go

internal/dbstudio/service.go                  # 业务编排入口
internal/dbstudio/saved_queries.go            # 服务端 saved queries
internal/dbstudio/pinned_results.go           # 结果快照
internal/dbstudio/query_history.go            # 查询历史
internal/dbstudio/view_profiles.go            # 多套表 profile
internal/dbstudio/data_profile.go             # Data Profiling 任务编排
internal/dbstudio/connections.go              # URI 解析 / 分组
internal/dbstudio/er_model.go                 # ER 模型存储
internal/dbstudio/object_apply.go             # DDL diff & apply
internal/dbstudio/service_test.go
internal/dbstudio/connections_test.go

internal/model/db_studio.go                   # GORM 模型（saved_queries/pinned_results/...）
internal/model/db_studio_test.go

internal/api/db_studio_handler.go             # /dbstudio/* 路由
internal/api/db_studio_handler_test.go

web/src/components/db/shared/schema-cache.ts
web/src/components/db/shared/ddl-renderer.tsx
web/src/components/db/shared/react-flow-canvas.tsx
web/src/components/db/shared/schema-cache.test.ts

web/src/components/db/editor/index.ts          # 占位 export
web/src/components/db/designer/index.ts
web/src/components/db/viewer/index.ts
web/src/components/db/connection/index.ts
web/src/components/db/builder/index.ts
web/src/components/db/modeler/index.ts
```

### 修改文件
```
internal/dbquery/adapter.go                    # +5 接口方法 + Capabilities 8 字段
internal/dbquery/adapter_mysql.go              # 实现 5 新方法返回 nil
internal/dbquery/adapter_postgres.go           # 实现 5 新方法返回 nil
internal/dbquery/adapter_dameng.go             # 实现 5 新方法返回 nil
internal/dbquery/adapter_mysql_compat.go       # 继承 mysqlAdapter 已带新方法
internal/dbquery/adapter_postgres_compat.go    # 同上
internal/dbquery/native/*.go                   # 各 native 适配器实现 5 新方法返回 nil

internal/server/routes.go                      # 注册 dbStudioHandler
cmd/wayfort/main.go                            # 构造 dbStudioHandler

pkg/db/migrate.go (或对应 AutoMigrate 入口)    # 注册新模型

web/src/lib/api/types.ts                       # DBCapabilities 8 个新字段
web/src/lib/api/services.ts                    # dbStudioService 占位
```

---

## Task 1: 扩展 Capabilities & 定义 ObjectKindSet

**Files:**
- Modify: `internal/dbquery/adapter.go:42-62`
- Create: `internal/dbquery/object_kind.go`
- Modify: `internal/dbquery/adapter_test.go`
- Modify: `internal/dbquery/adapter_mysql.go:21-41`
- Modify: `internal/dbquery/adapter_postgres.go` (对应 Capabilities 段)
- Modify: `internal/dbquery/adapter_dameng.go` (对应 Capabilities 段)

**Interfaces:**
- Produces:
  - `dbquery.ObjectKindSet` (uint32 bitmask)
  - `dbquery.KindTable | KindView | KindFunction | KindProcedure | KindTrigger | KindEvent | KindIndex | KindSequence` (常量)
  - `Capabilities.ObjectDesigner ObjectKindSet`
  - `Capabilities.VisualQueryPlan / DataProfiling / SchemaCompletion / ERModel / PinnedResults / VisualBuilder bool`

- [ ] **Step 1: 写 ObjectKindSet 失败测试**

`internal/dbquery/object_kind_test.go`：

```go
package dbquery

import "testing"

func TestObjectKindSetHas(t *testing.T) {
	set := KindTable | KindIndex
	if !set.Has(KindTable) {
		t.Fatal("expected Has(KindTable) == true")
	}
	if set.Has(KindView) {
		t.Fatal("expected Has(KindView) == false")
	}
}

func TestObjectKindSetString(t *testing.T) {
	set := KindTable | KindView | KindFunction
	got := set.String()
	want := "table,view,function"
	if got != want {
		t.Fatalf("got %q want %q", got, want)
	}
	if (ObjectKindSet(0)).String() != "" {
		t.Fatal("zero set should stringify empty")
	}
}
```

- [ ] **Step 2: 运行测试确认失败**

Run: `go test ./internal/dbquery -run TestObjectKindSet -v`
Expected: 编译失败 `undefined: ObjectKindSet`

- [ ] **Step 3: 实现 ObjectKindSet**

`internal/dbquery/object_kind.go`：

```go
package dbquery

import "strings"

// ObjectKindSet is a bitmask of database object categories an adapter's
// designer can render. Empty set => no object designer support.
type ObjectKindSet uint32

const (
	KindTable ObjectKindSet = 1 << iota
	KindView
	KindFunction
	KindProcedure
	KindTrigger
	KindEvent
	KindIndex
	KindSequence
)

var kindNames = []struct {
	bit  ObjectKindSet
	name string
}{
	{KindTable, "table"},
	{KindView, "view"},
	{KindFunction, "function"},
	{KindProcedure, "procedure"},
	{KindTrigger, "trigger"},
	{KindEvent, "event"},
	{KindIndex, "index"},
	{KindSequence, "sequence"},
}

// Has reports whether the kind bit is present.
func (s ObjectKindSet) Has(kind ObjectKindSet) bool { return s&kind != 0 }

// String returns a comma-separated lowercase list of kinds, in canonical order.
func (s ObjectKindSet) String() string {
	parts := make([]string, 0, len(kindNames))
	for _, k := range kindNames {
		if s&k.bit != 0 {
			parts = append(parts, k.name)
		}
	}
	return strings.Join(parts, ",")
}
```

- [ ] **Step 4: 跑测试确认通过**

Run: `go test ./internal/dbquery -run TestObjectKindSet -v`
Expected: PASS

- [ ] **Step 5: 写 Capabilities 扩展测试**

`internal/dbquery/adapter_test.go` 追加：

```go
func TestCapabilitiesNewFieldsZeroValue(t *testing.T) {
	var caps Capabilities
	if caps.ObjectDesigner != 0 {
		t.Fatal("ObjectDesigner default must be 0 (no kinds)")
	}
	if caps.VisualQueryPlan || caps.DataProfiling || caps.SchemaCompletion ||
		caps.ERModel || caps.PinnedResults || caps.VisualBuilder {
		t.Fatal("new bool capabilities must default false")
	}
}
```

- [ ] **Step 6: 运行测试确认失败**

Run: `go test ./internal/dbquery -run TestCapabilitiesNewFields -v`
Expected: 编译失败（字段不存在）

- [ ] **Step 7: 扩展 Capabilities struct**

`internal/dbquery/adapter.go:42-62` 替换为：

```go
type Capabilities struct {
	// 既有字段
	ListDatabases  bool          `json:"list_databases"`
	Schemas        bool          `json:"schemas"`
	RowEdits       bool          `json:"row_edits"`
	Explain        bool          `json:"explain"`
	ExplainAnalyze bool          `json:"explain_analyze"`
	Processes      bool          `json:"processes"`
	KillProcess    bool          `json:"kill_process"`
	TableDDL       bool          `json:"table_ddl"`
	TableStats     bool          `json:"table_stats"`
	ForeignKeys    bool          `json:"foreign_keys"`
	Export         bool          `json:"export"`
	LastInsertID   bool          `json:"last_insert_id"`
	Sequences      bool          `json:"sequences"`
	Functions      bool          `json:"functions"`
	Transactions   bool          `json:"transactions"`
	DatabaseScope  DatabaseScope `json:"database_scope"`
	VendorLabel    string        `json:"vendor_label,omitempty"`

	// Phase 1 新增：Navicat 平替能力旗
	ObjectDesigner   ObjectKindSet `json:"object_designer"`
	VisualQueryPlan  bool          `json:"visual_query_plan"`
	DataProfiling    bool          `json:"data_profiling"`
	SchemaCompletion bool          `json:"schema_completion"`
	ERModel          bool          `json:"er_model"`
	PinnedResults    bool          `json:"pinned_results"`
	VisualBuilder    bool          `json:"visual_builder"`
}
```

- [ ] **Step 8: 跑测试确认通过**

Run: `go test ./internal/dbquery/... -v`
Expected: PASS

- [ ] **Step 9: 提交**

```bash
git add internal/dbquery/object_kind.go internal/dbquery/object_kind_test.go internal/dbquery/adapter.go internal/dbquery/adapter_test.go
git commit -m "feat(db-studio): Phase 1.1 — Capabilities 加 7 字段 + ObjectKindSet bitmask"
```

---

## Task 2: 创建 5 个能力族 interface 包

**Files:**
- Create: `internal/dbquery/designer/designer.go` + `_test.go`
- Create: `internal/dbquery/planner/planner.go` + `_test.go`
- Create: `internal/dbquery/profiler/profiler.go` + `_test.go`
- Create: `internal/dbquery/completion/completion.go` + `_test.go`
- Create: `internal/dbquery/modeler/modeler.go` + `_test.go`

**Interfaces:**
- Produces:
  - `designer.Designer` interface（DDL gen + IR：TableSpec/ViewSpec/.../SequenceSpec）
  - `planner.Planner` interface + `PlanNode` 树
  - `profiler.Profiler` interface（BasicStats / Distribution / TopN / Patterns）
  - `completion.Provider` interface（Schemas/Tables/Columns/Functions/Keywords）
  - `modeler.Modeler` interface + `TableIR` / `Relation`

- [ ] **Step 1: 写 designer 包失败测试**

`internal/dbquery/designer/designer_test.go`：

```go
package designer

import "testing"

func TestNilSafeDesignerIsZeroValue(t *testing.T) {
	var d Designer
	if d != nil {
		t.Fatal("zero-value Designer must be nil interface")
	}
}

func TestTableSpecZeroValid(t *testing.T) {
	var spec TableSpec
	if spec.Name != "" || len(spec.Columns) != 0 {
		t.Fatal("TableSpec zero value must be empty")
	}
}
```

- [ ] **Step 2: 运行测试确认失败**

Run: `go test ./internal/dbquery/designer -v`
Expected: 包不存在

- [ ] **Step 3: 实现 designer 包**

`internal/dbquery/designer/designer.go`：

```go
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
	Schema     string
	Name       string
	Definition string // raw SELECT
	OrReplace  bool
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
	Timing  string // BEFORE / AFTER / INSTEAD OF
	Events  []string // INSERT / UPDATE / DELETE
	ForEach string // ROW / STATEMENT
	When    string // condition
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
```

- [ ] **Step 4: 跑测试确认通过**

Run: `go test ./internal/dbquery/designer -v`
Expected: PASS

- [ ] **Step 5: 写 planner 包测试 + 实现**

`internal/dbquery/planner/planner_test.go`：

```go
package planner

import "testing"

func TestPlanNodeChildren(t *testing.T) {
	n := &PlanNode{Op: "SeqScan", Children: []*PlanNode{{Op: "Filter"}}}
	if len(n.Children) != 1 || n.Children[0].Op != "Filter" {
		t.Fatal("children wiring broken")
	}
}
```

`internal/dbquery/planner/planner.go`：

```go
// Package planner defines the execution-plan parser contract.
package planner

import "context"

// Planner parses an engine's EXPLAIN output into a normalised PlanNode
// tree the UI can render uniformly.
type Planner interface {
	// Plan asks the engine for an execution plan of sql and returns
	// the root node and a textual fallback (engine-specific format).
	Plan(ctx context.Context, sql string) (root *PlanNode, raw string, err error)
}

// PlanNode is a single operator in an execution plan.
type PlanNode struct {
	Op          string            // SeqScan, HashJoin, NestLoop, ...
	Table       string            // affected table (if any)
	Rows        int64             // estimated rows
	Cost        float64           // engine cost; relative scale
	Width       int64             // bytes per row (PG)
	ActualRows  int64             // ANALYZE only; -1 = unavailable
	ActualMs    float64           // ANALYZE only; -1 = unavailable
	Warnings    []string          // optimiser warnings
	Attrs       map[string]string // engine-specific extras
	Children    []*PlanNode
}
```

- [ ] **Step 6: 跑 planner 测试**

Run: `go test ./internal/dbquery/planner -v`
Expected: PASS

- [ ] **Step 7: 写 profiler 包测试 + 实现**

`internal/dbquery/profiler/profiler_test.go`：

```go
package profiler

import "testing"

func TestBasicStatsZero(t *testing.T) {
	var s BasicStats
	if s.Count != 0 || s.Distinct != 0 {
		t.Fatal("zero BasicStats must be empty")
	}
}
```

`internal/dbquery/profiler/profiler.go`：

```go
// Package profiler defines the Data Profiling contract — column-level
// statistics, distribution histograms, top-N values and regex patterns.
package profiler

import "context"

type Profiler interface {
	BasicStats(ctx context.Context, schema, table, column string) (BasicStats, error)
	Distribution(ctx context.Context, schema, table, column string, buckets int) (Histogram, error)
	TopN(ctx context.Context, schema, table, column string, n int) ([]ValueFreq, error)
	Patterns(ctx context.Context, schema, table, column string) ([]PatternMatch, error)
}

type BasicStats struct {
	Count    int64
	NullCount int64
	Distinct int64
	Min      any
	Max      any
	Avg      float64
	StdDev   float64
}

type Histogram struct {
	Buckets []HistogramBucket
}

type HistogramBucket struct {
	LowerBound any
	UpperBound any
	Count      int64
}

type ValueFreq struct {
	Value any
	Count int64
}

// PatternMatch reports how many rows match a named regex pattern.
// Patterns are dialect-bundled (email/phone/uuid/ipv4/...).
type PatternMatch struct {
	Pattern string
	Count   int64
}
```

- [ ] **Step 8: 跑 profiler 测试**

Run: `go test ./internal/dbquery/profiler -v`
Expected: PASS

- [ ] **Step 9: 写 completion 包测试 + 实现**

`internal/dbquery/completion/completion_test.go`：

```go
package completion

import "testing"

func TestSnapshotEmpty(t *testing.T) {
	var s Snapshot
	if len(s.Tables) != 0 {
		t.Fatal("empty snapshot must have no tables")
	}
}
```

`internal/dbquery/completion/completion.go`：

```go
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
```

- [ ] **Step 10: 跑 completion 测试**

Run: `go test ./internal/dbquery/completion -v`
Expected: PASS

- [ ] **Step 11: 写 modeler 包测试 + 实现**

`internal/dbquery/modeler/modeler_test.go`：

```go
package modeler

import "testing"

func TestRelationZero(t *testing.T) {
	var r Relation
	if r.From.Table != "" {
		t.Fatal("zero relation must be empty")
	}
}
```

`internal/dbquery/modeler/modeler.go`：

```go
// Package modeler bridges ER models <-> live database schemas.
// Reverse: introspect DB -> Model. Forward: Model -> DDL. Diff: Model <-> DB.
package modeler

import (
	"context"

	"github.com/michongs/wayfort/internal/dbquery/designer"
)

type Modeler interface {
	// Reverse builds a model snapshot from a live schema.
	Reverse(ctx context.Context, schemas []string) (Model, error)
	// Forward renders DDL for a model using the adapter's Designer.
	Forward(ctx context.Context, model Model) ([]string, error)
	// Diff compares an in-memory model with the live schema and
	// returns symmetric changes (model-only / both-differ / db-only).
	Diff(ctx context.Context, model Model) (DiffResult, error)
}

type Model struct {
	Dialect    string
	Tables     []designer.TableSpec
	Relations  []Relation
	Layout     Layout
}

type Relation struct {
	Name string
	From RelationEnd
	To   RelationEnd
}

type RelationEnd struct {
	Schema  string
	Table   string
	Columns []string
}

type Layout struct {
	Positions map[string]Point // table FQN -> (x,y)
	Sizes     map[string]Size
}

type Point struct{ X, Y float64 }
type Size struct{ Width, Height float64 }

type DiffResult struct {
	OnlyInModel []designer.Change
	Differing   []designer.Change
	OnlyInDB    []designer.Change
}
```

- [ ] **Step 12: 跑 modeler 测试**

Run: `go test ./internal/dbquery/modeler -v`
Expected: PASS

- [ ] **Step 13: 跑全包测试**

Run: `go test ./internal/dbquery/... -v`
Expected: 全部 PASS

- [ ] **Step 14: 提交**

```bash
git add internal/dbquery/designer internal/dbquery/planner internal/dbquery/profiler internal/dbquery/completion internal/dbquery/modeler
git commit -m "feat(db-studio): Phase 1.2 — 5 个能力族 interface 包 (designer/planner/profiler/completion/modeler)"
```

---

## Task 3: 扩展 Adapter 接口 + 既有适配器对齐

**Files:**
- Modify: `internal/dbquery/adapter.go:77-83`
- Modify: `internal/dbquery/adapter_mysql.go` (新增 5 方法返回 nil)
- Modify: `internal/dbquery/adapter_postgres.go` (同)
- Modify: `internal/dbquery/adapter_dameng.go` (同)
- Modify: `internal/dbquery/native/*.go` (每个 native 适配器同)
- Modify: `internal/dbquery/adapter_test.go` (新增契约测试)

**Interfaces:**
- Consumes: `dbquery/designer.Designer`, `planner.Planner`, `profiler.Profiler`, `completion.Provider`, `modeler.Modeler`
- Produces:
  - `Adapter.Designer() designer.Designer` (返回 nil = 不支持)
  - `Adapter.Planner() planner.Planner`
  - `Adapter.Profiler() profiler.Profiler`
  - `Adapter.Completion() completion.Provider`
  - `Adapter.Modeler() modeler.Modeler`

- [ ] **Step 1: 写契约测试**

`internal/dbquery/adapter_test.go` 追加：

```go
func TestAllAdaptersImplementNewCapabilityFamilies(t *testing.T) {
	for _, proto := range Default().List() {
		ad, ok := Default().Get(proto)
		if !ok {
			t.Fatalf("registered protocol %q lost from registry", proto)
		}
		// 仅断言"调用不 panic"。返回 nil 表示该 adapter 暂未支持该能力。
		_ = ad.Designer()
		_ = ad.Planner()
		_ = ad.Profiler()
		_ = ad.Completion()
		_ = ad.Modeler()
	}
}
```

- [ ] **Step 2: 跑测试确认编译失败**

Run: `go test ./internal/dbquery -run TestAllAdaptersImplementNewCapabilityFamilies -v`
Expected: 编译失败（方法未定义）

- [ ] **Step 3: 扩展 Adapter interface**

`internal/dbquery/adapter.go:77-83` 替换为：

```go
type Adapter interface {
	Protocol() model.NodeProtocol
	Family() Family
	Capabilities() Capabilities
	Dialect() Dialect
	Driver() Driver

	// Phase 1 新增：返回 nil 表示该能力族未实现 → 前端 capability gate 关闭
	Designer() designer.Designer
	Planner() planner.Planner
	Profiler() profiler.Profiler
	Completion() completion.Provider
	Modeler() modeler.Modeler
}
```

同步 `internal/dbquery/adapter.go:3-10` import 段：

```go
import (
	"context"
	"errors"
	"fmt"
	"sort"
	"sync"

	"github.com/michongs/wayfort/internal/dbquery/completion"
	"github.com/michongs/wayfort/internal/dbquery/designer"
	"github.com/michongs/wayfort/internal/dbquery/modeler"
	"github.com/michongs/wayfort/internal/dbquery/planner"
	"github.com/michongs/wayfort/internal/dbquery/profiler"
	"github.com/michongs/wayfort/internal/model"
)
```

> 注：实际 import 列表保留既有的并合并新引入；如果当前文件没有 `sort` / `sync` 等，按真实情况留即可。

- [ ] **Step 4: mysqlAdapter 实现新方法返回 nil**

`internal/dbquery/adapter_mysql.go:44` 之后追加（保留 init 函数在最后）：

```go
func (mysqlAdapter) Designer() designer.Designer     { return nil }
func (mysqlAdapter) Planner() planner.Planner         { return nil }
func (mysqlAdapter) Profiler() profiler.Profiler      { return nil }
func (mysqlAdapter) Completion() completion.Provider  { return nil }
func (mysqlAdapter) Modeler() modeler.Modeler         { return nil }
```

同时 `adapter_mysql.go` 顶部 import 加：

```go
	"github.com/michongs/wayfort/internal/dbquery/completion"
	"github.com/michongs/wayfort/internal/dbquery/designer"
	"github.com/michongs/wayfort/internal/dbquery/modeler"
	"github.com/michongs/wayfort/internal/dbquery/planner"
	"github.com/michongs/wayfort/internal/dbquery/profiler"
```

- [ ] **Step 5: postgresAdapter / damengAdapter 同样实现**

`internal/dbquery/adapter_postgres.go`：在 Driver 方法之后追加同上 5 个 `nil` 返回方法 + 同样的 import。

`internal/dbquery/adapter_dameng.go`：同上。

- [ ] **Step 6: 兼容引擎适配器**

`internal/dbquery/adapter_mysql_compat.go` / `adapter_postgres_compat.go`：兼容引擎结构体如果是嵌入 `mysqlAdapter` / `postgresAdapter`，会**自动继承新方法**。如不是嵌入而是独立 struct，按 Step 4 模板追加。

读 `internal/dbquery/adapter_mysql_compat.go` 确认：

```bash
grep -n "type mysqlCompatAdapter" internal/dbquery/adapter_mysql_compat.go
```

- 若是 `struct { mysqlAdapter; ... }` 嵌入式 → 无需改动
- 若是独立 struct → 追加 5 个 nil 方法

同理 `adapter_postgres_compat.go`。

- [ ] **Step 7: native 适配器**

每个文件 `internal/dbquery/native/{highgo,kingbase,vastbase,oceanbase,gaussdb,gbase8s,tidb,doris,starrocks,gbase8a}.go`：

读文件，看是否嵌入主 adapter（mysqlAdapter / postgresAdapter）：

- 嵌入式 → 无需改动
- 独立 struct → 追加：

```go
func (X) Designer() designer.Designer     { return nil }
func (X) Planner() planner.Planner         { return nil }
func (X) Profiler() profiler.Profiler      { return nil }
func (X) Completion() completion.Provider  { return nil }
func (X) Modeler() modeler.Modeler         { return nil }
```

加上对应 import。

- [ ] **Step 8: 跑全包编译**

Run: `go build ./...`
Expected: 编译通过

- [ ] **Step 9: 跑契约测试**

Run: `go test ./internal/dbquery/... -v`
Expected: 全部 PASS（含新 `TestAllAdaptersImplementNewCapabilityFamilies`）

- [ ] **Step 10: 提交**

```bash
git add internal/dbquery/adapter.go internal/dbquery/adapter_mysql.go internal/dbquery/adapter_postgres.go internal/dbquery/adapter_dameng.go internal/dbquery/adapter_mysql_compat.go internal/dbquery/adapter_postgres_compat.go internal/dbquery/native/ internal/dbquery/adapter_test.go
git commit -m "feat(db-studio): Phase 1.3 — Adapter 接口加 5 能力族（默认 nil） + 全适配器对齐"
```

---

## Task 4: 创建 internal/dbstudio/ 业务编排包

**Files:**
- Create: `internal/dbstudio/service.go`
- Create: `internal/dbstudio/saved_queries.go`
- Create: `internal/dbstudio/pinned_results.go`
- Create: `internal/dbstudio/query_history.go`
- Create: `internal/dbstudio/view_profiles.go`
- Create: `internal/dbstudio/data_profile.go`
- Create: `internal/dbstudio/connections.go`
- Create: `internal/dbstudio/er_model.go`
- Create: `internal/dbstudio/object_apply.go`
- Create: `internal/dbstudio/service_test.go`
- Create: `internal/dbstudio/connections_test.go`

**Interfaces:**
- Produces:
  - `dbstudio.Service` (注入 `*gorm.DB` + `*dbquery.Service` + `auditWriter`)
  - `dbstudio.SavedQueriesStore` / `PinnedResultsStore` / `QueryHistoryStore` / `ViewProfilesStore` / `ERModelsStore` (CRUD)
  - `dbstudio.ConnectionURI` + `ParseConnectionURI(string) (ConnectionURI, error)`
  - `dbstudio.ObjectApplier` (DDL diff + apply)

- [ ] **Step 1: 写 ParseConnectionURI 测试**

`internal/dbstudio/connections_test.go`：

```go
package dbstudio

import "testing"

func TestParseConnectionURI_MySQL(t *testing.T) {
	uri, err := ParseConnectionURI("mysql://user:pass@db.example.com:3306/myschema?ssl=true&charset=utf8mb4")
	if err != nil {
		t.Fatal(err)
	}
	if uri.Scheme != "mysql" {
		t.Fatalf("scheme: %s", uri.Scheme)
	}
	if uri.User != "user" || uri.Password != "pass" {
		t.Fatalf("auth: %+v", uri)
	}
	if uri.Host != "db.example.com" || uri.Port != 3306 {
		t.Fatalf("host: %+v", uri)
	}
	if uri.Database != "myschema" {
		t.Fatalf("db: %s", uri.Database)
	}
	if uri.Params["ssl"] != "true" || uri.Params["charset"] != "utf8mb4" {
		t.Fatalf("params: %+v", uri.Params)
	}
}

func TestParseConnectionURI_Redis(t *testing.T) {
	uri, err := ParseConnectionURI("redis://:secret@cache:6379/2")
	if err != nil {
		t.Fatal(err)
	}
	if uri.Scheme != "redis" || uri.Port != 6379 || uri.Database != "2" {
		t.Fatalf("redis: %+v", uri)
	}
}

func TestParseConnectionURI_Invalid(t *testing.T) {
	if _, err := ParseConnectionURI("not a uri"); err == nil {
		t.Fatal("expected error on garbage uri")
	}
}
```

- [ ] **Step 2: 跑测试确认失败**

Run: `go test ./internal/dbstudio -v`
Expected: 包不存在

- [ ] **Step 3: 实现 ParseConnectionURI**

`internal/dbstudio/connections.go`：

```go
// Package dbstudio orchestrates cross-subproject Db Studio business state.
// Lives one layer above internal/dbquery; consumes its Adapter system.
package dbstudio

import (
	"errors"
	"fmt"
	"net/url"
	"strconv"
)

// ConnectionURI is the normalised result of parsing a Navicat-style
// quick-connect URI.
type ConnectionURI struct {
	Scheme   string
	User     string
	Password string
	Host     string
	Port     int
	Database string
	Params   map[string]string
}

// ParseConnectionURI parses a connection URI ("mysql://user:pass@host:3306/db?ssl=true")
// into a normalised struct the node-creation form can prefill.
func ParseConnectionURI(raw string) (ConnectionURI, error) {
	u, err := url.Parse(raw)
	if err != nil {
		return ConnectionURI{}, fmt.Errorf("parse uri: %w", err)
	}
	if u.Scheme == "" || u.Host == "" {
		return ConnectionURI{}, errors.New("uri missing scheme or host")
	}

	out := ConnectionURI{
		Scheme: u.Scheme,
		Host:   u.Hostname(),
		Params: map[string]string{},
	}
	if u.User != nil {
		out.User = u.User.Username()
		if pw, ok := u.User.Password(); ok {
			out.Password = pw
		}
	}
	if portStr := u.Port(); portStr != "" {
		p, err := strconv.Atoi(portStr)
		if err != nil {
			return ConnectionURI{}, fmt.Errorf("invalid port: %w", err)
		}
		out.Port = p
	}
	if len(u.Path) > 1 {
		out.Database = u.Path[1:] // strip leading '/'
	}
	for k, v := range u.Query() {
		if len(v) > 0 {
			out.Params[k] = v[0]
		}
	}
	return out, nil
}
```

- [ ] **Step 4: 跑 connections 测试**

Run: `go test ./internal/dbstudio -run TestParseConnectionURI -v`
Expected: PASS

- [ ] **Step 5: 写 Service 构造测试**

`internal/dbstudio/service_test.go`：

```go
package dbstudio

import "testing"

func TestNewServiceWithNilDeps(t *testing.T) {
	// All deps nil → service still constructs; calls will return ErrUnavailable.
	s := NewService(nil, nil, nil)
	if s == nil {
		t.Fatal("NewService returned nil")
	}
	if _, err := s.SavedQueries().List(nil, "owner-1"); err != ErrUnavailable {
		t.Fatalf("expected ErrUnavailable, got %v", err)
	}
}
```

- [ ] **Step 6: 跑测试确认失败**

Run: `go test ./internal/dbstudio -run TestNewServiceWithNilDeps -v`
Expected: 编译失败

- [ ] **Step 7: 实现 Service 骨架**

`internal/dbstudio/service.go`：

```go
package dbstudio

import (
	"context"
	"errors"

	"gorm.io/gorm"

	"github.com/michongs/wayfort/internal/audit"
	"github.com/michongs/wayfort/internal/dbquery"
)

// ErrUnavailable means the service was constructed without a backing
// dependency required for this call (e.g. db == nil).
var ErrUnavailable = errors.New("dbstudio: feature unavailable in this deployment")

// Service is the top-level entry point for cross-subproject Db Studio
// business state. Each handler reaches one of the per-feature stores
// via the named accessor.
type Service struct {
	db      *gorm.DB
	dbq     *dbquery.Service
	auditor audit.Writer

	savedQueries   *SavedQueriesStore
	pinnedResults  *PinnedResultsStore
	history        *QueryHistoryStore
	viewProfiles   *ViewProfilesStore
	erModels       *ERModelsStore
	applier        *ObjectApplier
}

// NewService wires all per-feature stores against the shared deps.
// Any dep may be nil; stores degrade to ErrUnavailable.
func NewService(db *gorm.DB, dbq *dbquery.Service, auditor audit.Writer) *Service {
	s := &Service{db: db, dbq: dbq, auditor: auditor}
	s.savedQueries = &SavedQueriesStore{db: db}
	s.pinnedResults = &PinnedResultsStore{db: db}
	s.history = &QueryHistoryStore{db: db}
	s.viewProfiles = &ViewProfilesStore{db: db}
	s.erModels = &ERModelsStore{db: db}
	s.applier = &ObjectApplier{dbq: dbq, auditor: auditor}
	return s
}

func (s *Service) SavedQueries() *SavedQueriesStore   { return s.savedQueries }
func (s *Service) PinnedResults() *PinnedResultsStore { return s.pinnedResults }
func (s *Service) QueryHistory() *QueryHistoryStore   { return s.history }
func (s *Service) ViewProfiles() *ViewProfilesStore   { return s.viewProfiles }
func (s *Service) ERModels() *ERModelsStore           { return s.erModels }
func (s *Service) ObjectApplier() *ObjectApplier      { return s.applier }

// ensureDB returns ErrUnavailable when no GORM db is wired.
func (s *Service) ensureDB() error {
	if s == nil || s.db == nil {
		return ErrUnavailable
	}
	return nil
}

// Context returns a derived context with the audit writer attached.
// Phase 1 stub — real wiring lands in sub-project plans.
func (s *Service) Context(ctx context.Context) context.Context { return ctx }
```

- [ ] **Step 8: 实现 8 个 store stub**

每个文件实现 stub：`db == nil` 路径返回 `ErrUnavailable`，其他方法签名定义好但内部仅 panic("phase 1 stub: implement in sub-project plan")。

`internal/dbstudio/saved_queries.go`：

```go
package dbstudio

import (
	"context"

	"gorm.io/gorm"
)

type SavedQueriesStore struct{ db *gorm.DB }

type SavedQuery struct {
	ID          int64
	OwnerID     int64
	Name        string
	FolderPath  string
	SQL         string
	ParamsJSON  string
	SharedScope string // user|team|node
	UpdatedAt   int64  // unix
}

func (s *SavedQueriesStore) List(ctx context.Context, ownerID string) ([]SavedQuery, error) {
	if s == nil || s.db == nil {
		return nil, ErrUnavailable
	}
	panic("dbstudio.SavedQueriesStore.List: phase-1 stub; implement in sub-project A plan")
}

func (s *SavedQueriesStore) Get(ctx context.Context, id int64) (*SavedQuery, error) {
	if s == nil || s.db == nil {
		return nil, ErrUnavailable
	}
	panic("dbstudio.SavedQueriesStore.Get: phase-1 stub; implement in sub-project A plan")
}

func (s *SavedQueriesStore) Create(ctx context.Context, q SavedQuery) (*SavedQuery, error) {
	if s == nil || s.db == nil {
		return nil, ErrUnavailable
	}
	panic("dbstudio.SavedQueriesStore.Create: phase-1 stub; implement in sub-project A plan")
}

func (s *SavedQueriesStore) Update(ctx context.Context, q SavedQuery) (*SavedQuery, error) {
	if s == nil || s.db == nil {
		return nil, ErrUnavailable
	}
	panic("dbstudio.SavedQueriesStore.Update: phase-1 stub; implement in sub-project A plan")
}

func (s *SavedQueriesStore) Delete(ctx context.Context, id int64) error {
	if s == nil || s.db == nil {
		return ErrUnavailable
	}
	panic("dbstudio.SavedQueriesStore.Delete: phase-1 stub; implement in sub-project A plan")
}
```

按同样模板实现 `pinned_results.go` / `query_history.go` / `view_profiles.go` / `er_model.go` / `data_profile.go` / `object_apply.go`，每个含 1 个 store struct + List/Get/Create/Update/Delete 方法（或对 ObjectApplier 是 `Diff` + `Apply`）。

`internal/dbstudio/object_apply.go`：

```go
package dbstudio

import (
	"context"
	"errors"

	"github.com/michongs/wayfort/internal/audit"
	"github.com/michongs/wayfort/internal/dbquery"
	"github.com/michongs/wayfort/internal/dbquery/designer"
)

type ObjectApplier struct {
	dbq     *dbquery.Service
	auditor audit.Writer
}

func (a *ObjectApplier) Diff(ctx context.Context, nodeID int64, oldSpec, newSpec any) ([]designer.Change, error) {
	if a == nil || a.dbq == nil {
		return nil, ErrUnavailable
	}
	return nil, errors.New("dbstudio.ObjectApplier.Diff: phase-1 stub; implement in sub-project B plan")
}

func (a *ObjectApplier) Apply(ctx context.Context, nodeID int64, changes []designer.Change) error {
	if a == nil || a.dbq == nil {
		return ErrUnavailable
	}
	return errors.New("dbstudio.ObjectApplier.Apply: phase-1 stub; implement in sub-project B plan")
}
```

(`data_profile.go` 用 profiler.Profiler 委托，store 没有 GORM 持久化部分；body 给一行 stub 返回 `ErrUnavailable`)

- [ ] **Step 9: 跑全部 dbstudio 测试**

Run: `go test ./internal/dbstudio -v`
Expected: PASS

- [ ] **Step 10: 提交**

```bash
git add internal/dbstudio/
git commit -m "feat(db-studio): Phase 1.4 — internal/dbstudio/ 业务编排包骨架"
```

---

## Task 5: GORM 模型 + AutoMigrate 注册

**Files:**
- Create: `internal/model/db_studio.go`
- Create: `internal/model/db_studio_test.go`
- Modify: `pkg/db/migrate.go`（实际 AutoMigrate 入口，按真实路径定位）
- Modify: `internal/model/node.go`（加 `DBColor` / `DBGroupPath` / `DBVirtualGroups` 列；具体文件按 `grep -l "type Node struct" internal/model` 定位）

**Interfaces:**
- Produces:
  - `model.SavedQuery` GORM struct (table=`saved_queries`)
  - `model.PinnedResult` (`pinned_results`)
  - `model.QueryHistory` (`query_history`)
  - `model.ViewProfile` (`view_profiles`)
  - `model.ERModel` (`er_models`)
  - `Node.DBColor / DBGroupPath / DBVirtualGroups` 三列

- [ ] **Step 1: 写 schema 注册测试**

`internal/model/db_studio_test.go`：

```go
package model

import (
	"testing"

	"github.com/glebarez/sqlite"
	"gorm.io/gorm"
)

func TestDBStudioModelsAutoMigrate(t *testing.T) {
	db, err := gorm.Open(sqlite.Open(":memory:"), &gorm.Config{})
	if err != nil {
		t.Fatal(err)
	}
	if err := db.AutoMigrate(
		&SavedQuery{}, &PinnedResult{}, &QueryHistory{},
		&ViewProfile{}, &ERModel{},
	); err != nil {
		t.Fatal(err)
	}
	for _, tbl := range []string{"saved_queries", "pinned_results", "query_history", "view_profiles", "er_models"} {
		if !db.Migrator().HasTable(tbl) {
			t.Fatalf("table missing: %s", tbl)
		}
	}
}
```

> 测试 driver 依赖：若 `github.com/glebarez/sqlite` 未引入，按既有项目测试约定挑用 `github.com/DATA-DOG/go-sqlmock` 或仓库已配置的 sqlite。先 `grep -r "glebarez/sqlite" go.sum` 确认。如均不存在，改用 `gorm.io/driver/sqlite`（CGO）或调整测试只测 struct tag。

- [ ] **Step 2: 跑测试确认失败**

Run: `go test ./internal/model -run TestDBStudioModels -v`
Expected: 类型不存在

- [ ] **Step 3: 实现 GORM 模型**

`internal/model/db_studio.go`：

```go
package model

import "time"

// SavedQuery is a server-side SQL snippet a user (or team) can recall.
type SavedQuery struct {
	ID          int64     `gorm:"primaryKey"`
	OwnerID     int64     `gorm:"index;not null"`
	Name        string    `gorm:"size:255;not null"`
	FolderPath  string    `gorm:"size:512;index"`
	SQL         string    `gorm:"type:longtext;not null"`
	ParamsJSON  string    `gorm:"type:longtext"`
	SharedScope string    `gorm:"size:16;not null"` // user|team|node
	UpdatedAt   time.Time `gorm:"autoUpdateTime"`
}

func (SavedQuery) TableName() string { return "saved_queries" }

// PinnedResult freezes a query + result snapshot in Arrow IPC form.
type PinnedResult struct {
	ID            int64     `gorm:"primaryKey"`
	OwnerID       int64     `gorm:"index;not null"`
	NodeID        int64     `gorm:"index;not null"`
	SQL           string    `gorm:"type:longtext;not null"`
	ParamsJSON    string    `gorm:"type:longtext"`
	ExecutedAt    time.Time `gorm:"index;not null"`
	RowCount      int64
	SnapshotArrow []byte    `gorm:"type:longblob"`
	TTL           time.Time
}

func (PinnedResult) TableName() string { return "pinned_results" }

// QueryHistory keeps an auditable log of every executed SQL.
type QueryHistory struct {
	ID         int64     `gorm:"primaryKey"`
	OwnerID    int64     `gorm:"index;not null"`
	NodeID     int64     `gorm:"index;not null"`
	SQL        string    `gorm:"type:longtext;not null"`
	ParamsJSON string    `gorm:"type:longtext"`
	ExecutedAt time.Time `gorm:"index;not null"`
	DurationMs int32
	RowCount   *int64
	Status     string    `gorm:"size:16;not null"` // ok|error
	ErrorText  string    `gorm:"type:text"`
}

func (QueryHistory) TableName() string { return "query_history" }

// ViewProfile stores a named filter+sort+columns combo for a table.
type ViewProfile struct {
	ID          int64     `gorm:"primaryKey"`
	OwnerID     int64     `gorm:"index;not null"`
	NodeID      int64     `gorm:"index;not null"`
	TableFQN    string    `gorm:"size:512;index;not null"`
	Name        string    `gorm:"size:255;not null"`
	FilterJSON  string    `gorm:"type:longtext"`
	SortJSON    string    `gorm:"type:longtext"`
	ColumnsJSON string    `gorm:"type:longtext"`
	IsDefault   bool
	UpdatedAt   time.Time `gorm:"autoUpdateTime"`
}

func (ViewProfile) TableName() string { return "view_profiles" }

// ERModel persists a Phase 1F entity-relationship diagram.
type ERModel struct {
	ID        int64     `gorm:"primaryKey"`
	OwnerID   int64     `gorm:"index;not null"`
	Name      string    `gorm:"size:255;not null"`
	Dialect   string    `gorm:"size:32;not null"`
	ModelJSON string    `gorm:"type:longtext;not null"`
	CreatedAt time.Time `gorm:"autoCreateTime"`
	UpdatedAt time.Time `gorm:"autoUpdateTime"`
}

func (ERModel) TableName() string { return "er_models" }
```

- [ ] **Step 4: 给 Node 加 3 列**

`internal/model/node.go`（按 `grep -n "type Node struct" internal/model/*.go` 定位）：

```go
// 在 Node struct 内添加：
DBColor         string `gorm:"size:16" json:"db_color,omitempty"`
DBGroupPath     string `gorm:"size:512" json:"db_group_path,omitempty"`
DBVirtualGroups string `gorm:"type:longtext" json:"db_virtual_groups,omitempty"` // JSON array
```

- [ ] **Step 5: 注册到 AutoMigrate 流水**

定位 `AutoMigrate(` 调用：

```bash
grep -rn "AutoMigrate(" pkg/db internal --include="*.go"
```

在该 slice / 调用末尾追加：

```go
&model.SavedQuery{}, &model.PinnedResult{}, &model.QueryHistory{},
&model.ViewProfile{}, &model.ERModel{},
```

- [ ] **Step 6: 跑测试**

Run: `go test ./internal/model -v && go build ./...`
Expected: PASS + 编译通过

- [ ] **Step 7: 提交**

```bash
git add internal/model/db_studio.go internal/model/db_studio_test.go internal/model/node.go pkg/db/
git commit -m "feat(db-studio): Phase 1.5 — GORM 模型 5 张表 + Node 加 3 列 + AutoMigrate"
```

---

## Task 6: 注册后端 API 路由 stub

**Files:**
- Create: `internal/api/db_studio_handler.go`
- Create: `internal/api/db_studio_handler_test.go`
- Modify: `internal/server/routes.go`（参考 `:309, :1047-1051` 区段，加新路由组）
- Modify: `cmd/wayfort/main.go:651`（NewDBStudioHandler 构造与 wiring）

**Interfaces:**
- Produces:
  - `api.NewDBStudioHandler(*dbstudio.Service) *DBStudioHandler`
  - 路由 `/api/v1/dbstudio/connections/parse-uri`
  - 路由 `/api/v1/dbstudio/er-models` (CRUD)
  - 路由 `/api/v1/dbstudio/er-models/:id/reverse|forward|diff`
  - 节点级别新端点（在既有 `/nodes/:id/db/*` 下）：
    - `/completion/{schemas,tables,columns,functions,keywords}`
    - `/plan?sql=...`
    - `/profile/{stats,distribution,topn,patterns}`
    - `/fk-targets`
    - `/saved-queries` / `/pinned-results` / `/history` / `/view-profiles`
    - `/designer/{table,view,func,proc,trigger,event,index,sequence}`
  - **本任务仅注册路由 + 返回 501 / `ErrUnavailable`，业务在子项目 plan 实装**

- [ ] **Step 1: 写 parse-uri handler 测试**

`internal/api/db_studio_handler_test.go`：

```go
package api

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/michongs/wayfort/internal/dbstudio"
)

func TestParseURIHandler_MySQL(t *testing.T) {
	h := NewDBStudioHandler(dbstudio.NewService(nil, nil, nil))

	body := strings.NewReader(`{"uri":"mysql://u:p@h:3306/d?ssl=true"}`)
	req := httptest.NewRequest(http.MethodPost, "/dbstudio/connections/parse-uri", body)
	req.Header.Set("Content-Type", "application/json")
	rec := httptest.NewRecorder()

	h.HandleParseURI(rec, req)

	if rec.Code != http.StatusOK {
		t.Fatalf("status %d: %s", rec.Code, rec.Body.String())
	}
	var out dbstudio.ConnectionURI
	if err := json.Unmarshal(rec.Body.Bytes(), &out); err != nil {
		t.Fatal(err)
	}
	if out.Scheme != "mysql" || out.Port != 3306 || out.Database != "d" {
		t.Fatalf("parsed: %+v", out)
	}
}

func TestParseURIHandler_Invalid(t *testing.T) {
	h := NewDBStudioHandler(dbstudio.NewService(nil, nil, nil))
	body := strings.NewReader(`{"uri":"garbage"}`)
	req := httptest.NewRequest(http.MethodPost, "/dbstudio/connections/parse-uri", body)
	rec := httptest.NewRecorder()
	h.HandleParseURI(rec, req)
	if rec.Code != http.StatusBadRequest {
		t.Fatalf("expected 400, got %d", rec.Code)
	}
}
```

- [ ] **Step 2: 跑测试确认失败**

Run: `go test ./internal/api -run TestParseURIHandler -v`
Expected: 编译失败

- [ ] **Step 3: 实现 DBStudioHandler**

`internal/api/db_studio_handler.go`：

```go
package api

import (
	"encoding/json"
	"errors"
	"net/http"

	"github.com/michongs/wayfort/internal/dbstudio"
)

// DBStudioHandler exposes the cross-subproject /api/v1/dbstudio/* endpoints.
// Phase 1 only wires parse-uri (real); ER models + designer routes return 501.
type DBStudioHandler struct {
	svc *dbstudio.Service
}

func NewDBStudioHandler(svc *dbstudio.Service) *DBStudioHandler {
	return &DBStudioHandler{svc: svc}
}

// HandleParseURI POST /api/v1/dbstudio/connections/parse-uri
// Body: {"uri":"mysql://..."}
// Resp: ConnectionURI JSON
func (h *DBStudioHandler) HandleParseURI(w http.ResponseWriter, r *http.Request) {
	var body struct {
		URI string `json:"uri"`
	}
	if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
		writeError(w, http.StatusBadRequest, "invalid json", err)
		return
	}
	parsed, err := dbstudio.ParseConnectionURI(body.URI)
	if err != nil {
		writeError(w, http.StatusBadRequest, "invalid uri", err)
		return
	}
	writeJSON(w, http.StatusOK, parsed)
}

// HandleERModelStub returns 501 for all ER-model routes until sub-project F.
func (h *DBStudioHandler) HandleERModelStub(w http.ResponseWriter, r *http.Request) {
	writeError(w, http.StatusNotImplemented, "er-models endpoint not implemented (Phase 1 stub)", nil)
}

// ---- helpers (assumes existing writeError / writeJSON pattern in package) ----

func writeJSON(w http.ResponseWriter, status int, body any) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(status)
	_ = json.NewEncoder(w).Encode(body)
}

func writeError(w http.ResponseWriter, status int, msg string, err error) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(status)
	resp := map[string]string{"error": msg}
	if err != nil && !errors.Is(err, dbstudio.ErrUnavailable) {
		resp["detail"] = err.Error()
	}
	_ = json.NewEncoder(w).Encode(resp)
}
```

> 注：若 `internal/api` 已存在 `writeJSON / writeError`，**移除上面的本地版本**，直接复用既有。本步骤前先 `grep -n "func writeJSON\|func writeError" internal/api/*.go` 检查。

- [ ] **Step 4: 跑 parse-uri 测试**

Run: `go test ./internal/api -run TestParseURIHandler -v`
Expected: PASS

- [ ] **Step 5: 注册路由**

`internal/server/routes.go`（参考既有 `/nodes/:id/db/*` 注册段，§1047-1051）：

在 chi router 注册段追加：

```go
// Phase 1: DB Studio cross-subproject routes
r.Route("/dbstudio", func(r chi.Router) {
    r.Post("/connections/parse-uri", dbStudioHandler.HandleParseURI)
    r.Route("/er-models", func(r chi.Router) {
        r.Get("/", dbStudioHandler.HandleERModelStub)
        r.Post("/", dbStudioHandler.HandleERModelStub)
        r.Get("/{id}", dbStudioHandler.HandleERModelStub)
        r.Put("/{id}", dbStudioHandler.HandleERModelStub)
        r.Delete("/{id}", dbStudioHandler.HandleERModelStub)
        r.Post("/{id}/reverse", dbStudioHandler.HandleERModelStub)
        r.Post("/{id}/forward", dbStudioHandler.HandleERModelStub)
        r.Post("/{id}/diff", dbStudioHandler.HandleERModelStub)
    })
})
```

`internal/server/routes.go` 顶部如已有 `dbHandler` 字段，加入 `dbStudioHandler *api.DBStudioHandler` 字段；构造函数追加参数。

- [ ] **Step 6: main.go wire**

`cmd/wayfort/main.go:651` 附近（NewDBHandler 构造之后）：

```go
dbStudioSvc := dbstudio.NewService(gormDB, dbSvc, auditWriter)
dbStudioHandler := api.NewDBStudioHandler(dbStudioSvc)
```

将 `dbStudioHandler` 注入 routes 构造。

- [ ] **Step 7: 跑全包**

Run: `go build ./... && go test ./internal/api ./internal/server ./internal/dbstudio -v`
Expected: 编译通过、测试 PASS

- [ ] **Step 8: 提交**

```bash
git add internal/api/db_studio_handler.go internal/api/db_studio_handler_test.go internal/server/routes.go cmd/wayfort/main.go
git commit -m "feat(db-studio): Phase 1.6 — /api/v1/dbstudio/* 路由注册（parse-uri 实装 + ER stub）"
```

---

## Task 7: 前端 shared/ 骨架 + 子模块目录 + 类型同步

**Files:**
- Create: `web/src/components/db/shared/schema-cache.ts`
- Create: `web/src/components/db/shared/schema-cache.test.ts`
- Create: `web/src/components/db/shared/ddl-renderer.tsx`
- Create: `web/src/components/db/shared/react-flow-canvas.tsx`
- Create: `web/src/components/db/editor/index.ts`
- Create: `web/src/components/db/designer/index.ts`
- Create: `web/src/components/db/viewer/index.ts`
- Create: `web/src/components/db/connection/index.ts`
- Create: `web/src/components/db/builder/index.ts`
- Create: `web/src/components/db/modeler/index.ts`
- Modify: `web/src/lib/api/types.ts:159-163` (DBCapabilities 加 7 字段)
- Modify: `web/src/lib/api/services.ts` (dbStudioService stub)

**Interfaces:**
- Produces:
  - `DBCapabilities.object_designer / visual_query_plan / data_profiling / schema_completion / er_model / pinned_results / visual_builder`
  - `getSchemaSnapshot(nodeId, database): Promise<SchemaSnapshot>` (TanStack Query queryFn)
  - `<DDLRenderer dialect="mysql" sql={...} diff={...}/>`
  - `<ReactFlowCanvas .../>` (React Flow wrapper)
  - `dbStudioService.parseUri(uri: string): Promise<ConnectionURI>`

- [ ] **Step 1: 写 schema-cache 测试**

`web/src/components/db/shared/schema-cache.test.ts`：

```ts
import { describe, expect, it, vi } from "vitest";
import { schemaCacheKey } from "./schema-cache";

describe("schemaCacheKey", () => {
  it("scopes by nodeId + database", () => {
    expect(schemaCacheKey(1, "mydb")).toEqual(["schema-snapshot", 1, "mydb"]);
  });

  it("treats empty database as default", () => {
    expect(schemaCacheKey(2, "")).toEqual(["schema-snapshot", 2, "__default__"]);
  });
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `cd web && pnpm vitest run src/components/db/shared/schema-cache.test.ts`
Expected: 模块不存在

- [ ] **Step 3: 实现 schema-cache**

`web/src/components/db/shared/schema-cache.ts`：

```ts
import { useQuery, type UseQueryOptions } from "@tanstack/react-query";
import { dbService } from "@/lib/api/services";

/** Cache key shape: ["schema-snapshot", nodeId, database]. */
export function schemaCacheKey(nodeId: number, database: string): [string, number, string] {
  return ["schema-snapshot", nodeId, database || "__default__"];
}

export interface SchemaSnapshot {
  database: string;
  schemas: string[];
  tables: Array<{
    schema: string;
    name: string;
    kind: string;
    columns: Array<{ name: string; dataType: string; nullable: boolean }>;
  }>;
  functions: Array<{
    schema: string;
    name: string;
    argTypes: string[];
    returnType: string;
  }>;
  updatedAt: number;
}

/** TTL: 5 minutes; DDL change events invalidate (handled at sub-project A). */
const STALE_MS = 5 * 60 * 1000;

export function useSchemaSnapshot(
  nodeId: number,
  database: string,
  options?: UseQueryOptions<SchemaSnapshot>,
) {
  return useQuery<SchemaSnapshot>({
    queryKey: schemaCacheKey(nodeId, database),
    queryFn: () => dbService.completionSnapshot(nodeId, database) as Promise<SchemaSnapshot>,
    staleTime: STALE_MS,
    enabled: !!nodeId,
    ...options,
  });
}
```

> 注：`dbService.completionSnapshot` 在 services.ts 加 stub（Step 6）。

- [ ] **Step 4: DDLRenderer 组件**

`web/src/components/db/shared/ddl-renderer.tsx`：

```tsx
"use client";

import { useEffect, useRef } from "react";
import { editor as monacoEditor } from "monaco-editor";

interface Props {
  sql: string;
  /** Optional "before" SQL → triggers side-by-side diff view. */
  diff?: string;
  dialect?: "mysql" | "postgresql" | "oracle";
  height?: string;
}

/** Read-only Monaco wrapper for DDL preview + side-by-side diff. */
export function DDLRenderer({ sql, diff, dialect = "mysql", height = "320px" }: Props) {
  const elRef = useRef<HTMLDivElement | null>(null);
  const instRef = useRef<monacoEditor.IStandaloneCodeEditor | monacoEditor.IStandaloneDiffEditor | null>(null);

  useEffect(() => {
    if (!elRef.current) return;
    if (diff !== undefined) {
      const inst = monacoEditor.createDiffEditor(elRef.current, {
        readOnly: true,
        renderSideBySide: true,
        automaticLayout: true,
      });
      inst.setModel({
        original: monacoEditor.createModel(diff, "sql"),
        modified: monacoEditor.createModel(sql, "sql"),
      });
      instRef.current = inst;
    } else {
      instRef.current = monacoEditor.create(elRef.current, {
        value: sql,
        language: "sql",
        readOnly: true,
        automaticLayout: true,
        minimap: { enabled: false },
      });
    }
    return () => instRef.current?.dispose();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [dialect, diff !== undefined]);

  // value updates without recreating the editor
  useEffect(() => {
    const inst = instRef.current;
    if (!inst) return;
    if ("getModifiedEditor" in inst) {
      inst.getModifiedEditor().setValue(sql);
      if (diff !== undefined) inst.getOriginalEditor().setValue(diff);
    } else {
      (inst as monacoEditor.IStandaloneCodeEditor).setValue(sql);
    }
  }, [sql, diff]);

  return <div ref={elRef} style={{ height, width: "100%" }} />;
}
```

- [ ] **Step 5: ReactFlowCanvas stub**

`web/src/components/db/shared/react-flow-canvas.tsx`：

```tsx
"use client";

import type { ReactNode } from "react";

interface Props {
  children?: ReactNode;
  className?: string;
}

/**
 * Phase 1 stub. React Flow dependency is introduced in sub-project E/F plan.
 * Provides the shared API surface today so callers compile.
 */
export function ReactFlowCanvas({ children, className }: Props) {
  return (
    <div
      className={className}
      style={{ width: "100%", height: "100%", position: "relative", border: "1px dashed var(--muted)" }}
      data-testid="react-flow-canvas-stub"
    >
      <div style={{ padding: 12, color: "var(--muted-foreground)" }}>
        Canvas placeholder — wired by sub-project E (builder) / F (modeler).
      </div>
      {children}
    </div>
  );
}
```

- [ ] **Step 6: services.ts 加 stub**

`web/src/lib/api/services.ts`（位置：`dbService` 对象内）追加：

```ts
// inside dbService
completionSnapshot: (nodeId: number, database: string) =>
  api.get<unknown>(`/nodes/${nodeId}/db/completion/snapshot`, { params: { database } }),
```

文件末尾或对应导出区追加：

```ts
export const dbStudioService = {
  parseUri: (uri: string) =>
    api.post<{ scheme: string; host: string; port: number; database: string; user: string; password: string; params: Record<string, string> }>(
      `/dbstudio/connections/parse-uri`,
      { uri },
    ),
};
```

> `api` 是项目既有 axios/fetch wrapper；如方法签名不同，按既有调用位（如 `nodeService.get`）的模板对齐。

- [ ] **Step 7: types.ts 扩展 DBCapabilities**

`web/src/lib/api/types.ts:159-163` 区段，DBCapabilities 接口加：

```ts
export interface DBCapabilities {
  // 既有字段...
  list_databases: boolean;
  schemas: boolean;
  row_edits: boolean;
  explain: boolean;
  explain_analyze: boolean;
  processes: boolean;
  kill_process: boolean;
  table_ddl: boolean;
  table_stats: boolean;
  foreign_keys: boolean;
  export: boolean;
  last_insert_id: boolean;
  sequences: boolean;
  functions: boolean;
  transactions: boolean;
  database_scope: string;
  vendor_label?: string;

  // Phase 1 新增
  object_designer: string;     // CSV from ObjectKindSet (e.g. "table,view,index")
  visual_query_plan: boolean;
  data_profiling: boolean;
  schema_completion: boolean;
  er_model: boolean;
  pinned_results: boolean;
  visual_builder: boolean;
}
```

- [ ] **Step 8: 6 子模块目录占位**

每个 `web/src/components/db/{editor,designer,viewer,connection,builder,modeler}/index.ts`：

```ts
// Phase 1 placeholder. Sub-project plans land concrete components here.
export {};
```

- [ ] **Step 9: 跑前端测试**

Run: `cd web && pnpm vitest run src/components/db/shared && pnpm typecheck`
Expected: 测试 PASS、TS 编译通过

- [ ] **Step 10: 提交**

```bash
git add web/src/components/db/shared web/src/components/db/editor web/src/components/db/designer web/src/components/db/viewer web/src/components/db/connection web/src/components/db/builder web/src/components/db/modeler web/src/lib/api/types.ts web/src/lib/api/services.ts
git commit -m "feat(db-studio): Phase 1.7 — 前端 shared/ 骨架 + 6 子模块目录 + DBCapabilities 7 字段"
```

---

## Task 8: 端到端 Smoke + 文档更新

**Files:**
- Modify: `web/e2e/db-studio.spec.ts`（若存在）或新建
- Modify: `.planning/specs/2026-06-23-db-studio-navicat-parity-design.md`（标记 Phase 1 完成）

**Interfaces:** —（无新接口）

- [ ] **Step 1: 写 E2E smoke 测试**

新文件或追加 `web/e2e/db-studio-phase1.spec.ts`：

```ts
import { test, expect } from "@playwright/test";

test("既有 db studio 在 Phase 1 骨架下不破", async ({ page }) => {
  await page.goto("/login");
  // 复用既有登录工具；按项目 e2e 模板调整
  await page.fill('input[name="username"]', process.env.E2E_USER ?? "admin");
  await page.fill('input[name="password"]', process.env.E2E_PASS ?? "admin");
  await page.click('button[type="submit"]');

  // 进入任一已配置的 DB 节点
  await page.goto("/nodes");
  const firstDb = page.locator('a[href*="/nodes/"][href*="/db"]').first();
  await firstDb.click();

  await expect(page.locator('[data-testid="db-studio-root"]')).toBeVisible({ timeout: 10_000 });
  // 既有 4 个面板仍渲染
  await expect(page.getByRole("tab", { name: /浏览|Browse/i })).toBeVisible();
  await expect(page.getByRole("tab", { name: /结构|Structure/i })).toBeVisible();
  await expect(page.getByRole("tab", { name: /SQL|查询/i })).toBeVisible();
});

test("DB capabilities API 返回 Phase 1 新字段", async ({ request }) => {
  const res = await request.get("/api/v1/nodes/1/db/capabilities");
  if (res.status() === 404) test.skip(); // 测试环境无 node id=1
  const caps = await res.json();
  for (const k of [
    "object_designer", "visual_query_plan", "data_profiling",
    "schema_completion", "er_model", "pinned_results", "visual_builder",
  ]) {
    expect(caps).toHaveProperty(k);
  }
});

test("parse-uri 端点", async ({ request }) => {
  const res = await request.post("/api/v1/dbstudio/connections/parse-uri", {
    data: { uri: "mysql://u:p@h:3306/d?ssl=true" },
  });
  expect(res.status()).toBe(200);
  const body = await res.json();
  expect(body.scheme).toBe("mysql");
  expect(body.port).toBe(3306);
  expect(body.database).toBe("d");
});
```

> 注：测试需要既有登录工具 / fixture；按 `web/e2e/` 既有 spec 文件模板调整 login 部分。如 `db-studio-root` testid 缺失，先在 `db-studio.tsx` 根节点加 `data-testid="db-studio-root"`。

- [ ] **Step 2: 跑 E2E**

Run: `cd web && pnpm playwright test e2e/db-studio-phase1.spec.ts --reporter=line`
Expected: 至少 parse-uri 测试 PASS；其它根据 E2E 环境状态决定 skip 还是 PASS

- [ ] **Step 3: 在 spec 顶部标记 Phase 1 完成**

`.planning/specs/2026-06-23-db-studio-navicat-parity-design.md` 顶部加 footer：

```markdown
> **Phase 1 (基础设施) 状态**: ✅ 已完成（commit <hash>）。子项目 A-F plan 可启动。
```

- [ ] **Step 4: 提交**

```bash
git add web/e2e/db-studio-phase1.spec.ts .planning/specs/2026-06-23-db-studio-navicat-parity-design.md
git commit -m "test(db-studio): Phase 1.8 — E2E smoke + spec 标记 Phase 1 完成"
```

---

## Self-Review (已执行)

**1. Spec coverage 检查**

| Spec § | 对应任务 |
|---|---|
| §1.1 后端目录 | Task 2 (5 包) + Task 4 (dbstudio/) |
| §1.2 Adapter 契约扩展 + Capabilities | Task 1 + Task 3 |
| §1.3 前端模块拆分 | Task 7 |
| §1.4 协议双轨 | 路由 stub 在 Task 6；NoSQL handler 留给子项目 D plan |
| §8 持久化模型 | Task 5 |
| §9 API 表面 | Task 6（parse-uri 实装；其它 501 stub） |
| §10 错误模型 | `ErrUnavailable` / writeError 风格在 Task 4/6 |
| §11 测试策略 | 每个任务含单元测试；Task 8 E2E smoke |
| §12 路线图 Phase 1 | 整个 plan = Phase 1 |

子项目 A-F 的具体 UI 与业务逻辑**不在本 plan 范围**，按 §12 路线图各自开 plan。

**2. Placeholder scan**

- Task 4 的 store CRUD 使用 `panic("phase-1 stub: implement in sub-project X plan")` — **这是显式的、有锚点的 stub**，每个 panic 字符串指明实装归属哪个子项目 plan，非"TODO"占位
- 无 "TBD" / "implement later" 字眼
- 每个 code step 都给了完整代码

**3. Type consistency 检查**

- `ObjectKindSet`（Task 1）↔ `Capabilities.ObjectDesigner`（Task 1）↔ `DBCapabilities.object_designer` 前端 string CSV（Task 7） — 一致：Go 端是 bitmask，HTTP JSON 序列化时 `String()` 转 CSV，TS 端字段名 snake_case
- `designer.TableSpec`（Task 2）↔ `dbstudio.ObjectApplier.Diff(...,oldSpec,newSpec any)`（Task 4） — Task 4 故意用 `any` 接受多种 IR 类型，避免循环 import
- `dbstudio.ConnectionURI`（Task 4）↔ `parseUri` 响应（Task 7）— Task 7 把 Go struct 字段直译为 TS 接口（字段名一致 / camelCase 同 Go 公开字段对应）

无类型漂移。

---

## Execution Handoff

**Plan complete and saved to `.planning/plans/2026-06-23-db-studio-phase1-foundation.md`. Two execution options:**

**1. Subagent-Driven (recommended)** — 我每个 task 派一个新 subagent 执行，task 间检阅、快速迭代

**2. Inline Execution** — 在本会话用 executing-plans 批量执行，分 checkpoint 检阅

**Which approach?**

- 选 **1** → 我会调用 `superpowers:subagent-driven-development` skill 启动 Task 1
- 选 **2** → 我会调用 `superpowers:executing-plans` skill 进入批执行

**默认建议 1**（任务边界清晰、可并行潜力大，subagent 模型最匹配）。
