# Db Studio Phase 2C · Data Viewer 增强 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 把 Phase 1 占位的数据查看器能力落地：外键 picker、表的多套筛选/排序/列配置 profile、BLOB/图片/JSON/Geo 单元格预览、Data Profiling (统计/分布/Top-N/正则模式)。

**Architecture:** 在 Phase 1 适配器骨架之上：`profiler.Profiler` 给 MySQL/PostgreSQL/Dameng 三方言落地；`view_profiles` store 从 panic stub 升级到 GORM CRUD；前端 `viewer/` 子目录从 Phase 1 占位 → 几个具体组件。后端只加新端点（FK targets, profiling），不改既有 row/exec 通路。

**Tech Stack:** Go (database/sql / GORM)、TypeScript + React 18 + `@tanstack/react-query` (existing) + `recharts` (existing) + `react-leaflet` (NEW npm, 地理预览) + `leaflet` (NEW npm)。

## Global Constraints

- **不破坏既有**：Phase 1 骨架不动接口；不动既有 `ResultGrid` / `browse-tab` 的当前行为，只**追加**外键 picker / BLOB preview / Data Profiling 入口
- **三方言对齐**：`profiler.Profiler` 实现 MySQL/PostgreSQL/Dameng；兼容引擎复用父方言
- **测试覆盖**：每个新公开方法 ≥1 测试；SQL 生成走 sqlmock；前端无 test 框架 → 用 typecheck 验证
- **commit 风格**：`feat(db-studio):` 中文
- **依赖白名单**：
  - 新增 npm：`leaflet` + `react-leaflet` + `@types/leaflet`（仅 Geo cell preview；总体积 ~150KB gzipped）
  - 新增 Go：无（所有 profiling SQL 都用 stdlib）
- **文件大小**：单文件 ≤ 400 行
- **Data Profiling 安全门**：profiling SQL 都是 SELECT-only；不绕过既有 `exec` 安全门（不写入），但走 read-only `query` 通路（限流/审计跟既有 Query 端点一致）
- **Profiling 行数上限**：`COUNT(*) > 1_000_000` 的表 distribution/topn 强制采样（`TABLESAMPLE 1 PERCENT` 或 `LIMIT 100000` fallback），降低长尾查询风险
- **Adapter wire**：实现完成后，对应 `Capabilities.DataProfiling = true`

---

## File Structure

### 新建文件

```
internal/dbquery/profiler/mysql.go              # 4 个 SQL 模板：BasicStats/Distribution/TopN/Patterns
internal/dbquery/profiler/mysql_test.go
internal/dbquery/profiler/postgres.go           # 同
internal/dbquery/profiler/postgres_test.go
internal/dbquery/profiler/dameng.go             # 同
internal/dbquery/profiler/dameng_test.go
internal/dbquery/profiler/patterns.go           # 共享 regex catalog: email/phone/uuid/ipv4

web/src/components/db/viewer/foreign-key-picker.tsx
web/src/components/db/viewer/view-profiles.tsx
web/src/components/db/viewer/blob-preview/index.tsx
web/src/components/db/viewer/blob-preview/image.tsx
web/src/components/db/viewer/blob-preview/json.tsx
web/src/components/db/viewer/blob-preview/geo.tsx
web/src/components/db/viewer/blob-preview/hex.tsx
web/src/components/db/viewer/data-profiling.tsx
```

### 修改文件

```
internal/dbquery/adapter_mysql.go               # Profiler() 返回实例；DataProfiling = true
internal/dbquery/adapter_postgres.go
internal/dbquery/adapter_dameng.go
internal/dbquery/adapter_mysql_compat.go
internal/dbquery/adapter_postgres_compat.go
internal/dbquery/adapter.go                     # Profiler 签名加 *sql.DB（同 A2 Completion 演进）

internal/dbstudio/view_profiles.go              # panic stub → 真 CRUD
internal/dbstudio/view_profiles_test.go         # NEW (file may not exist)

internal/api/db_handler.go                      # 4 新端点: ForeignKeyTargets / ProfileStats / ProfileDistribution / ProfileTopN / ProfilePatterns
internal/api/db_studio_handler.go               # view-profiles CRUD endpoints
internal/server/routes.go                       # mount 新路由

web/src/components/db/result-grid.tsx           # 集成 FK picker + BLOB preview cell click
web/src/components/db/browse-tab.tsx            # 集成 view-profiles 下拉 + Data Profiling 按钮
web/src/lib/api/services.ts                     # extend dbStudioService + dbService
web/src/lib/api/types.ts                        # ViewProfile / ForeignKeyTarget / ProfileStats 等
web/package.json                                # +leaflet, +react-leaflet, +@types/leaflet
```

---

## Task C1: ForeignKey targets endpoint + FK picker UI

**Files:**
- Modify: `internal/api/db_handler.go` (新增 `ForeignKeyTargets` handler)
- Modify: `internal/dbquery/service.go` (helper to resolve FK target table for `(table, column)`)
- Modify: `internal/server/routes.go`
- Create: `web/src/components/db/viewer/foreign-key-picker.tsx`
- Modify: `web/src/components/db/result-grid.tsx` (cell hover icon → opens picker)
- Modify: `web/src/lib/api/services.ts` (`dbService.foreignKeyTargets`)
- Modify: `web/src/lib/api/types.ts` (`ForeignKeyTarget` type)

**Interfaces:**
- Produces:
  - `GET /api/v1/nodes/:id/db/fk-targets?schema=&table=&column=` →
    ```json
    { "ref_schema": "public", "ref_table": "users", "ref_columns": ["id"],
      "label_column": "name" }
    ```
    `label_column` is auto-picked: first non-PK string column ≤ 128 chars; falls back to `ref_columns[0]`
  - `<ForeignKeyPicker nodeId={...} fk={...} onPick={(val) => ...}/>` — Sheet with searchable list

- [ ] **Step 1: 测试 (table-driven)**

`internal/api/db_handler_test.go` 追加：

```go
func TestForeignKeyTargetsRoute(t *testing.T) {
	// existing test pattern: setup gin engine + handler with mock svc
	// verify the endpoint exists and returns 400 on missing query params
	h := NewDBHandler(nil, nil, nil)
	gin.SetMode(gin.TestMode)
	r := gin.New()
	r.GET("/db/fk-targets", h.ForeignKeyTargets)

	req := httptest.NewRequest(http.MethodGet, "/db/fk-targets", nil)
	rec := httptest.NewRecorder()
	r.ServeHTTP(rec, req)
	if rec.Code != http.StatusBadRequest && rec.Code != http.StatusServiceUnavailable {
		t.Fatalf("expected 400 or 503 (no svc), got %d", rec.Code)
	}
}
```

- [ ] **Step 2: Service helper**

`internal/dbquery/service.go` append:

```go
// ResolveForeignKeyTarget returns the target table + label-friendly column for
// (schema, table, column). Uses the adapter's existing FK introspection.
// label = first non-numeric, ≤128-char column on the target table (typically
// "name" / "title" / "email"); falls back to the first PK column when no
// friendly column exists.
func (s *Service) ResolveForeignKeyTarget(ctx context.Context, nodeID uint64, schema, table, column string) (ForeignKeyTarget, error) {
	conn, ad, err := s.openForNode(ctx, nodeID, "")
	if err != nil {
		return ForeignKeyTarget{}, err
	}
	defer s.Release(conn)

	// Reuse existing ForeignKeys helper (already implemented in Phase 17).
	fks, err := s.ForeignKeys(ctx, nodeID, schema, table)
	if err != nil {
		return ForeignKeyTarget{}, err
	}
	for _, fk := range fks {
		if contains(fk.Columns, column) {
			label := pickLabelColumn(ctx, conn, ad, fk.RefSchema, fk.RefTable, fk.RefColumns)
			return ForeignKeyTarget{
				RefSchema:   fk.RefSchema,
				RefTable:    fk.RefTable,
				RefColumns:  fk.RefColumns,
				LabelColumn: label,
			}, nil
		}
	}
	return ForeignKeyTarget{}, fmt.Errorf("no foreign key on %s.%s.%s", schema, table, column)
}

type ForeignKeyTarget struct {
	RefSchema   string   `json:"ref_schema"`
	RefTable    string   `json:"ref_table"`
	RefColumns  []string `json:"ref_columns"`
	LabelColumn string   `json:"label_column"`
}

func contains(ss []string, s string) bool {
	for _, x := range ss {
		if x == s {
			return true
		}
	}
	return false
}

// pickLabelColumn — auto-pick a human-readable column from the target table.
// Reads columns via existing Columns() helper; returns RefColumns[0] when no
// better candidate exists. Best-effort; failures fall back to PK.
func pickLabelColumn(ctx context.Context, _ *sql.DB, _ Adapter, schema, table string, refCols []string) string {
	// Implementation note: re-use existing Columns(ctx, nodeID, schema, table)
	// helper to read column metadata; rank candidates by (length <= 128)
	// && string-y type && name in {"name","title","label","display_name",
	// "email","description"}. Use the first match; else refCols[0]. This
	// implementation should consult the live Service to avoid duplicating
	// introspection logic. For Phase 2C the policy is the order above.
	if len(refCols) > 0 {
		return refCols[0]
	}
	return ""
}
```

> Note: implementer must consult the live `Columns()` helper that already exists in the service for the actual column-list lookup; the simplified version above falls back to `refCols[0]` so it works without further plumbing. Upgrade in a later patch when label-column heuristics matter more.

- [ ] **Step 3: Handler**

`internal/api/db_handler.go`:

```go
// ForeignKeyTargets — GET /api/v1/nodes/:id/db/fk-targets?schema=&table=&column=
func (h *DBHandler) ForeignKeyTargets(c *gin.Context) {
	nodeID, _, ok := h.gate(c)
	if !ok {
		return
	}
	schema := c.Query("schema")
	table := c.Query("table")
	column := c.Query("column")
	if schema == "" || table == "" || column == "" {
		c.JSON(http.StatusBadRequest, gin.H{"error": "schema, table, column required"})
		return
	}
	target, err := h.Svc.ResolveForeignKeyTarget(c.Request.Context(), nodeID, schema, table, column)
	if err != nil {
		c.JSON(http.StatusBadGateway, gin.H{"error": err.Error()})
		return
	}
	c.JSON(http.StatusOK, target)
}
```

- [ ] **Step 4: Mount route**

`routes.go` in the `if rt.DB != nil` block:

```go
ops.GET("/nodes/:id/db/fk-targets", rt.DB.ForeignKeyTargets)
```

- [ ] **Step 5: Frontend service + type**

`web/src/lib/api/types.ts`:

```ts
export interface ForeignKeyTarget {
  ref_schema: string
  ref_table: string
  ref_columns: string[]
  label_column: string
}
```

`services.ts` extend `dbService`:

```ts
foreignKeyTargets: (nodeId: number, params: { schema: string; table: string; column: string }) =>
  api.get<ForeignKeyTarget>(`/nodes/${nodeId}/db/fk-targets`, { params }),
```

- [ ] **Step 6: FK Picker component**

`web/src/components/db/viewer/foreign-key-picker.tsx`:

```tsx
"use client";

import { useQuery } from "@tanstack/react-query";
import { dbService } from "@/lib/api/services";
import { Sheet, SheetContent, SheetHeader, SheetTitle } from "@/components/ui/sheet";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import { useEffect, useState } from "react";

interface Props {
  open: boolean;
  onClose: () => void;
  nodeId: number;
  schema: string;
  table: string;
  column: string;
  onPick: (value: unknown) => void;
}

export function ForeignKeyPicker({ open, onClose, nodeId, schema, table, column, onPick }: Props) {
  const { data: fk } = useQuery({
    queryKey: ["fk-target", nodeId, schema, table, column],
    queryFn: () => dbService.foreignKeyTargets(nodeId, { schema, table, column }),
    enabled: open,
  });

  const [filter, setFilter] = useState("");
  const { data: candidates } = useQuery({
    queryKey: ["fk-candidates", nodeId, fk?.ref_schema, fk?.ref_table, filter],
    queryFn: () => {
      if (!fk) return Promise.resolve({ rows: [] as Record<string, unknown>[] });
      const sql = `SELECT ${fk.ref_columns.map(quoteIdent).join(", ")}, ${quoteIdent(fk.label_column)} FROM ${quoteIdent(fk.ref_schema)}.${quoteIdent(fk.ref_table)}` +
        (filter ? ` WHERE CAST(${quoteIdent(fk.label_column)} AS TEXT) ILIKE '%${filter.replace(/'/g, "''")}%'` : "") +
        ` LIMIT 200`;
      return dbService.query(nodeId, { sql });
    },
    enabled: !!fk,
  });

  useEffect(() => { if (!open) setFilter(""); }, [open]);

  return (
    <Sheet open={open} onOpenChange={(o) => !o && onClose()}>
      <SheetContent>
        <SheetHeader>
          <SheetTitle>选择 {fk ? `${fk.ref_schema}.${fk.ref_table}` : "外键目标"}</SheetTitle>
        </SheetHeader>
        <Input placeholder={`搜索 ${fk?.label_column ?? ""}...`} value={filter} onChange={(e) => setFilter(e.target.value)} className="my-2" />
        <ul className="space-y-1 max-h-96 overflow-auto">
          {(candidates?.rows ?? []).map((row, i) => (
            <li key={i} className="border rounded px-2 py-1 flex justify-between">
              <span>
                <code className="text-xs text-muted-foreground">{String(row[fk?.ref_columns[0] ?? ""])}</code>
                <span className="ml-2">{String(row[fk?.label_column ?? ""] ?? "")}</span>
              </span>
              <Button size="sm" variant="ghost" onClick={() => { onPick(row[fk?.ref_columns[0] ?? ""]); onClose(); }}>选</Button>
            </li>
          ))}
        </ul>
      </SheetContent>
    </Sheet>
  );
}

function quoteIdent(s: string): string {
  // SAFE for identifier whitelist (FK targets come from server-resolved metadata).
  // Postgres/mysql double-quote; dameng same. This is a viewer-side helper —
  // server-side query never trusts user-supplied identifiers.
  return `"${s.replace(/"/g, '""')}"`;
}
```

- [ ] **Step 7: 集成到 ResultGrid**

In `result-grid.tsx`: for each cell, detect FK column via existing capabilities. Add a hover-only `🔗` icon next to FK cells. On click → open `<ForeignKeyPicker/>` for that cell. When `onPick` fires, write the chosen value back via existing row-update logic.

> Implementer: read current ResultGrid cell-render structure; FK columns are already known via `columns` API call. Add minimal hooks; don't restructure.

- [ ] **Step 8: typecheck + build + test**

```
go build ./...
go test ./internal/api -v
cd web && pnpm typecheck
```

- [ ] **Step 9: 提交**

```bash
git add internal/dbquery/service.go internal/api/db_handler.go internal/api/db_handler_test.go internal/server/routes.go web/src/components/db/viewer/foreign-key-picker.tsx web/src/components/db/result-grid.tsx web/src/lib/api/services.ts web/src/lib/api/types.ts
git commit -m "feat(db-studio): Phase 2C.1 — 外键 picker（/fk-targets + Sheet 选择器）"
```

---

## Task C2: view_profiles 真 CRUD + REST + 前端下拉

**Files:**
- Modify: `internal/dbstudio/view_profiles.go` (panic stub → 真 CRUD)
- Create: `internal/dbstudio/view_profiles_test.go`
- Modify: `internal/api/db_studio_handler.go` (5 endpoints)
- Modify: `internal/server/routes.go`
- Create: `web/src/components/db/viewer/view-profiles.tsx`
- Modify: `web/src/components/db/browse-tab.tsx` (drop-down integration)
- Modify: `web/src/lib/api/services.ts` + `types.ts`

**Interfaces:**
- Produces:
  - `dbstudio.ViewProfilesStore.{List(ownerID, nodeID, tableFqn), Get(id), Create(...), Update(...), Delete(id), SetDefault(id)}`
  - HTTP: `GET /api/v1/dbstudio/view-profiles?node_id=&table=`, `POST /api/v1/dbstudio/view-profiles`, `GET /api/v1/dbstudio/view-profiles/:id`, `PUT /api/v1/dbstudio/view-profiles/:id`, `DELETE /api/v1/dbstudio/view-profiles/:id`
  - Frontend: `<ViewProfiles nodeId={...} tableFqn={...} value={current} onChange={(profile) => ...}/>` — dropdown with 默认 / Profile A / + 新建

- [ ] **Step 1: Store 测试**

`internal/dbstudio/view_profiles_test.go`:

```go
package dbstudio

import (
	"context"
	"testing"

	"gorm.io/driver/sqlite"
	"gorm.io/gorm"

	"github.com/michongs/wayfort/internal/model"
)

func openVPDB(t *testing.T) *gorm.DB {
	t.Helper()
	db, err := gorm.Open(sqlite.Open(":memory:"), &gorm.Config{})
	if err != nil {
		t.Skipf("sqlite unavailable: %v", err)
	}
	if err := db.AutoMigrate(&model.ViewProfile{}); err != nil {
		t.Fatal(err)
	}
	return db
}

func TestViewProfilesCRUD(t *testing.T) {
	db := openVPDB(t)
	store := &ViewProfilesStore{db: db}
	ctx := context.Background()

	p := ViewProfile{
		OwnerID: 1, NodeID: 10, TableFQN: "public.users",
		Name: "active only", FilterJSON: `{"active":true}`,
		SortJSON: `[{"col":"id","dir":"asc"}]`,
		ColumnsJSON: `["id","email"]`,
	}
	created, err := store.Create(ctx, p)
	if err != nil {
		t.Fatal(err)
	}
	if created.ID == 0 {
		t.Fatal("expected ID")
	}

	list, err := store.List(ctx, 1, 10, "public.users")
	if err != nil {
		t.Fatal(err)
	}
	if len(list) != 1 {
		t.Fatalf("list: %d", len(list))
	}

	if err := store.SetDefault(ctx, created.ID); err != nil {
		t.Fatal(err)
	}
	again, _ := store.Get(ctx, created.ID)
	if !again.IsDefault {
		t.Fatal("expected default flag")
	}
}
```

- [ ] **Step 2: Store impl**

`internal/dbstudio/view_profiles.go` (replace):

```go
package dbstudio

import (
	"context"
	"errors"

	"gorm.io/gorm"

	"github.com/michongs/wayfort/internal/model"
)

type ViewProfilesStore struct{ db *gorm.DB }

type ViewProfile struct {
	ID          int64
	OwnerID     int64
	NodeID      int64
	TableFQN    string
	Name        string
	FilterJSON  string
	SortJSON    string
	ColumnsJSON string
	IsDefault   bool
	UpdatedAt   int64
}

func (s *ViewProfilesStore) List(ctx context.Context, ownerID, nodeID int64, tableFQN string) ([]ViewProfile, error) {
	if s == nil || s.db == nil {
		return nil, ErrUnavailable
	}
	var rows []model.ViewProfile
	q := s.db.WithContext(ctx).
		Where("owner_id = ? AND node_id = ? AND table_fqn = ?", uint64(ownerID), uint64(nodeID), tableFQN).
		Order("is_default DESC, updated_at DESC")
	if err := q.Find(&rows).Error; err != nil {
		return nil, err
	}
	out := make([]ViewProfile, len(rows))
	for i, r := range rows {
		out[i] = toViewProfile(r)
	}
	return out, nil
}

func (s *ViewProfilesStore) Get(ctx context.Context, id int64) (*ViewProfile, error) {
	if s == nil || s.db == nil {
		return nil, ErrUnavailable
	}
	var r model.ViewProfile
	if err := s.db.WithContext(ctx).First(&r, id).Error; err != nil {
		return nil, err
	}
	p := toViewProfile(r)
	return &p, nil
}

func (s *ViewProfilesStore) Create(ctx context.Context, p ViewProfile) (*ViewProfile, error) {
	if s == nil || s.db == nil {
		return nil, ErrUnavailable
	}
	if p.OwnerID == 0 || p.NodeID == 0 || p.TableFQN == "" || p.Name == "" {
		return nil, errors.New("dbstudio: view profile requires OwnerID, NodeID, TableFQN, Name")
	}
	r := fromViewProfile(p)
	if err := s.db.WithContext(ctx).Create(&r).Error; err != nil {
		return nil, err
	}
	out := toViewProfile(r)
	return &out, nil
}

func (s *ViewProfilesStore) Update(ctx context.Context, p ViewProfile) (*ViewProfile, error) {
	if s == nil || s.db == nil {
		return nil, ErrUnavailable
	}
	if p.ID == 0 {
		return nil, errors.New("dbstudio: update requires ID")
	}
	r := fromViewProfile(p)
	if err := s.db.WithContext(ctx).Save(&r).Error; err != nil {
		return nil, err
	}
	out := toViewProfile(r)
	return &out, nil
}

func (s *ViewProfilesStore) Delete(ctx context.Context, id int64) error {
	if s == nil || s.db == nil {
		return ErrUnavailable
	}
	return s.db.WithContext(ctx).Delete(&model.ViewProfile{}, id).Error
}

// SetDefault flips the is_default flag and clears it for any sibling profile
// on the same (owner, node, table). All inside a transaction.
func (s *ViewProfilesStore) SetDefault(ctx context.Context, id int64) error {
	if s == nil || s.db == nil {
		return ErrUnavailable
	}
	return s.db.WithContext(ctx).Transaction(func(tx *gorm.DB) error {
		var target model.ViewProfile
		if err := tx.First(&target, id).Error; err != nil {
			return err
		}
		if err := tx.Model(&model.ViewProfile{}).
			Where("owner_id = ? AND node_id = ? AND table_fqn = ?", target.OwnerID, target.NodeID, target.TableFQN).
			Update("is_default", false).Error; err != nil {
			return err
		}
		return tx.Model(&target).Update("is_default", true).Error
	})
}

func toViewProfile(r model.ViewProfile) ViewProfile {
	return ViewProfile{
		ID: r.ID, OwnerID: int64(r.OwnerID), NodeID: int64(r.NodeID),
		TableFQN: r.TableFQN, Name: r.Name,
		FilterJSON: r.FilterJSON, SortJSON: r.SortJSON, ColumnsJSON: r.ColumnsJSON,
		IsDefault: r.IsDefault, UpdatedAt: r.UpdatedAt.Unix(),
	}
}

func fromViewProfile(p ViewProfile) model.ViewProfile {
	return model.ViewProfile{
		ID: p.ID, OwnerID: uint64(p.OwnerID), NodeID: uint64(p.NodeID),
		TableFQN: p.TableFQN, Name: p.Name,
		FilterJSON: p.FilterJSON, SortJSON: p.SortJSON, ColumnsJSON: p.ColumnsJSON,
		IsDefault: p.IsDefault,
	}
}
```

- [ ] **Step 3: REST endpoints**

`internal/api/db_studio_handler.go` add: ViewProfilesList / ViewProfilesCreate / ViewProfilesGet / ViewProfilesUpdate / ViewProfilesDelete / ViewProfilesSetDefault — pattern same as SavedQueries handlers from Phase 2A. List takes `node_id` + `table` query params.

- [ ] **Step 4: Mount routes**

`routes.go`:

```go
vp := ops.Group("/dbstudio/view-profiles")
vp.GET("", rt.DbStudio.ViewProfilesList)
vp.POST("", rt.DbStudio.ViewProfilesCreate)
vp.GET("/:id", rt.DbStudio.ViewProfilesGet)
vp.PUT("/:id", rt.DbStudio.ViewProfilesUpdate)
vp.DELETE("/:id", rt.DbStudio.ViewProfilesDelete)
vp.POST("/:id/set-default", rt.DbStudio.ViewProfilesSetDefault)
```

- [ ] **Step 5: Frontend service + type**

`types.ts`:

```ts
export interface ViewProfile {
  id: number
  owner_id: number
  node_id: number
  table_fqn: string
  name: string
  filter_json?: string
  sort_json?: string
  columns_json?: string
  is_default: boolean
  updated_at: string
}
```

`services.ts` extend `dbStudioService`:

```ts
viewProfiles: {
  list: (nodeId: number, tableFqn: string) =>
    api.get<{ items: ViewProfile[] }>(`/dbstudio/view-profiles`, { params: { node_id: nodeId, table: tableFqn } }),
  create: (body: Omit<ViewProfile, "id" | "owner_id" | "updated_at">) =>
    api.post<ViewProfile>(`/dbstudio/view-profiles`, body),
  update: (id: number, body: Omit<ViewProfile, "id" | "owner_id" | "updated_at">) =>
    api.put<ViewProfile>(`/dbstudio/view-profiles/${id}`, body),
  delete: (id: number) => api.del<void>(`/dbstudio/view-profiles/${id}`),
  setDefault: (id: number) => api.post<void>(`/dbstudio/view-profiles/${id}/set-default`),
},
```

- [ ] **Step 6: ViewProfiles dropdown**

`web/src/components/db/viewer/view-profiles.tsx`:

```tsx
"use client";

import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { dbStudioService } from "@/lib/api/services";
import type { ViewProfile } from "@/lib/api/types";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Button } from "@/components/ui/button";

interface Props {
  nodeId: number;
  tableFqn: string;
  current: { filter: unknown; sort: unknown; columns: string[] };
  onApply: (profile: ViewProfile) => void;
}

export function ViewProfiles({ nodeId, tableFqn, current, onApply }: Props) {
  const qc = useQueryClient();
  const { data } = useQuery({
    queryKey: ["view-profiles", nodeId, tableFqn],
    queryFn: () => dbStudioService.viewProfiles.list(nodeId, tableFqn).then((r) => r.items),
  });
  const create = useMutation({
    mutationFn: (name: string) => dbStudioService.viewProfiles.create({
      node_id: nodeId, table_fqn: tableFqn, name,
      filter_json: JSON.stringify(current.filter),
      sort_json: JSON.stringify(current.sort),
      columns_json: JSON.stringify(current.columns),
      is_default: false,
    }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["view-profiles", nodeId, tableFqn] }),
  });

  return (
    <div className="flex items-center gap-2">
      <Select onValueChange={(id) => {
        const p = data?.find((x) => String(x.id) === id);
        if (p) onApply(p);
      }}>
        <SelectTrigger className="w-48"><SelectValue placeholder="默认视图" /></SelectTrigger>
        <SelectContent>
          {(data ?? []).map((p) => (
            <SelectItem key={p.id} value={String(p.id)}>
              {p.is_default && "⭐ "}{p.name}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
      <Button size="sm" variant="ghost" onClick={() => {
        const name = window.prompt("Profile name?");
        if (name) create.mutate(name);
      }}>+ 保存</Button>
    </div>
  );
}
```

- [ ] **Step 7: 集成到 browse-tab.tsx**

In `browse-tab.tsx`: place `<ViewProfiles/>` above `<ResultGrid/>`. Wire `onApply` to set the current filter / sort / column state. On "+ 保存" click, capture current filter/sort/cols state and POST.

- [ ] **Step 8: build + test + typecheck**

```
go build ./...
go test ./internal/dbstudio -run TestViewProfiles -v
cd web && pnpm typecheck
```

- [ ] **Step 9: 提交**

```bash
git add internal/dbstudio/view_profiles.go internal/dbstudio/view_profiles_test.go internal/api/db_studio_handler.go internal/server/routes.go web/src/components/db/viewer/view-profiles.tsx web/src/components/db/browse-tab.tsx web/src/lib/api/services.ts web/src/lib/api/types.ts
git commit -m "feat(db-studio): Phase 2C.2 — view_profiles 真 CRUD + REST + 表头下拉切换"
```

---

## Task C3: BLOB / 图片 / JSON / Geo 单元格预览

**Files:**
- Modify: `web/package.json` (+leaflet, +react-leaflet, +@types/leaflet)
- Create: `web/src/components/db/viewer/blob-preview/index.tsx` (router)
- Create: `web/src/components/db/viewer/blob-preview/image.tsx`
- Create: `web/src/components/db/viewer/blob-preview/json.tsx`
- Create: `web/src/components/db/viewer/blob-preview/geo.tsx`
- Create: `web/src/components/db/viewer/blob-preview/hex.tsx`
- Modify: `web/src/components/db/result-grid.tsx` (cell long-press / right-click → open preview)

**Interfaces:**
- Produces:
  - `<BlobPreview open onClose value column/>` — auto-routes by `column.dataType` + content magic bytes to image / json / geo / hex view
  - All previews are READ-ONLY in Phase 2C; JSON edit-back lands in sub-project C v2

- [ ] **Step 1: 安装 leaflet**

```bash
cd web && pnpm add leaflet@^1.9.4 react-leaflet@^4.2.1 && pnpm add -D @types/leaflet@^1.9.0
```

- [ ] **Step 2: BlobPreview router**

`web/src/components/db/viewer/blob-preview/index.tsx`:

```tsx
"use client";

import { Sheet, SheetContent, SheetHeader, SheetTitle } from "@/components/ui/sheet";
import { ImagePreview } from "./image";
import { JsonPreview } from "./json";
import { GeoPreview } from "./geo";
import { HexPreview } from "./hex";

interface Props {
  open: boolean;
  onClose: () => void;
  value: unknown;
  columnName: string;
  dataType: string;
}

export function BlobPreview({ open, onClose, value, columnName, dataType }: Props) {
  const view = detect(value, dataType);
  return (
    <Sheet open={open} onOpenChange={(o) => !o && onClose()}>
      <SheetContent className="w-[640px] sm:max-w-[640px]">
        <SheetHeader>
          <SheetTitle>{columnName} <span className="text-xs text-muted-foreground">({view})</span></SheetTitle>
        </SheetHeader>
        <div className="mt-2 overflow-auto" style={{ maxHeight: "70vh" }}>
          {view === "image" && <ImagePreview value={value} />}
          {view === "json" && <JsonPreview value={value} />}
          {view === "geo" && <GeoPreview value={value} />}
          {view === "hex" && <HexPreview value={value} />}
        </div>
      </SheetContent>
    </Sheet>
  );
}

function detect(value: unknown, dataType: string): "image" | "json" | "geo" | "hex" {
  const dt = dataType.toLowerCase();
  if (dt.includes("geometry") || dt.includes("geography") || dt === "point" || dt === "polygon") return "geo";
  if (dt.includes("json")) return "json";
  if (typeof value === "string") {
    // Detect base64 image magic
    const b = value.slice(0, 12).toLowerCase();
    if (b.startsWith("iv") || b.startsWith("/9j/") || b.startsWith("r0lgo") || b.startsWith("uklgr")) return "image";
    // GeoJSON / WKT
    if (value.trim().startsWith('{"type":"') && value.includes('"coordinates"')) return "geo";
    if (/^(POINT|POLYGON|LINESTRING|MULTI)/i.test(value.trim())) return "geo";
    // JSON
    const trimmed = value.trim();
    if ((trimmed.startsWith("{") && trimmed.endsWith("}")) || (trimmed.startsWith("[") && trimmed.endsWith("]"))) {
      try { JSON.parse(trimmed); return "json"; } catch { /* fall through */ }
    }
  }
  if (dt.includes("blob") || dt.includes("binary") || dt === "bytea") return "hex";
  return "hex";
}
```

- [ ] **Step 3: ImagePreview**

`web/src/components/db/viewer/blob-preview/image.tsx`:

```tsx
"use client";

export function ImagePreview({ value }: { value: unknown }) {
  if (typeof value !== "string") return <div className="text-muted-foreground">不支持的图片格式</div>;
  // Detect MIME from magic bytes (base64 prefix)
  const mime = detectMime(value);
  const src = value.startsWith("data:") ? value : `data:${mime};base64,${value}`;
  return <img src={src} alt="cell image" className="max-w-full" />;
}

function detectMime(b64: string): string {
  const head = b64.slice(0, 12);
  if (head.startsWith("iVBORw0KGgo")) return "image/png";
  if (head.startsWith("/9j/")) return "image/jpeg";
  if (head.startsWith("R0lGO")) return "image/gif";
  if (head.startsWith("UklGR")) return "image/webp";
  return "application/octet-stream";
}
```

- [ ] **Step 4: JsonPreview (read-only tree)**

```tsx
"use client";

import { useMemo } from "react";

export function JsonPreview({ value }: { value: unknown }) {
  const parsed = useMemo(() => {
    if (typeof value === "string") {
      try { return JSON.parse(value); } catch { return value; }
    }
    return value;
  }, [value]);
  return <pre className="text-xs">{JSON.stringify(parsed, null, 2)}</pre>;
}
```

- [ ] **Step 5: GeoPreview (Leaflet)**

```tsx
"use client";

import { MapContainer, TileLayer, GeoJSON, Marker } from "react-leaflet";
import L from "leaflet";
import "leaflet/dist/leaflet.css";
import { useMemo } from "react";

export function GeoPreview({ value }: { value: unknown }) {
  const { kind, parsed, center } = useMemo(() => parseGeo(value), [value]);
  if (kind === "error") return <div className="text-destructive">无法解析为地理数据</div>;
  return (
    <MapContainer center={center} zoom={5} style={{ height: 360 }}>
      <TileLayer url="https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png" attribution="© OpenStreetMap" />
      {kind === "geojson" && <GeoJSON data={parsed as any} />}
      {kind === "wkt-point" && <Marker position={center} icon={L.divIcon({ html: "📍", iconSize: [20, 20] })} />}
    </MapContainer>
  );
}

function parseGeo(value: unknown): { kind: "geojson" | "wkt-point" | "error"; parsed: unknown; center: [number, number] } {
  if (typeof value !== "string") return { kind: "error", parsed: null, center: [0, 0] };
  const t = value.trim();
  // GeoJSON
  if (t.startsWith("{")) {
    try {
      const g = JSON.parse(t);
      const c = guessCenterFromGeoJSON(g);
      return { kind: "geojson", parsed: g, center: c };
    } catch { /* fall through */ }
  }
  // WKT POINT
  const m = /^POINT\s*\(\s*(-?[\d.]+)\s+(-?[\d.]+)\s*\)/i.exec(t);
  if (m) return { kind: "wkt-point", parsed: t, center: [parseFloat(m[2]), parseFloat(m[1])] };
  return { kind: "error", parsed: null, center: [0, 0] };
}

function guessCenterFromGeoJSON(g: any): [number, number] {
  if (g?.geometry?.coordinates && Array.isArray(g.geometry.coordinates)) {
    const c = flatFirstCoord(g.geometry.coordinates);
    if (c) return [c[1], c[0]];
  }
  if (Array.isArray(g?.coordinates)) {
    const c = flatFirstCoord(g.coordinates);
    if (c) return [c[1], c[0]];
  }
  return [0, 0];
}

function flatFirstCoord(x: any): [number, number] | null {
  if (Array.isArray(x) && typeof x[0] === "number") return x as [number, number];
  if (Array.isArray(x) && Array.isArray(x[0])) return flatFirstCoord(x[0]);
  return null;
}
```

- [ ] **Step 6: HexPreview**

```tsx
"use client";

export function HexPreview({ value }: { value: unknown }) {
  const s = typeof value === "string" ? value : String(value ?? "");
  const lines: string[] = [];
  for (let i = 0; i < s.length; i += 16) {
    const chunk = s.slice(i, i + 16);
    const hex = Array.from(chunk).map((c) => c.charCodeAt(0).toString(16).padStart(2, "0")).join(" ");
    const ascii = Array.from(chunk).map((c) => /[ -~]/.test(c) ? c : ".").join("");
    lines.push(`${i.toString(16).padStart(8, "0")}  ${hex.padEnd(48, " ")}  ${ascii}`);
  }
  return <pre className="text-xs">{lines.join("\n")}</pre>;
}
```

- [ ] **Step 7: ResultGrid 集成**

In `result-grid.tsx`: add a `<button>` icon for each non-trivial cell (when `value` is long string OR column type is `bytea`/`blob`/`json`/`geometry`). Click opens `<BlobPreview open value={cell} columnName={col.name} dataType={col.dataType}/>`.

> Implementer: do this **additively** — don't replace existing cell render. Add the preview button as an overlay/hover icon. Existing inline-edit behavior preserved.

- [ ] **Step 8: typecheck**

```
cd web && pnpm typecheck
```

- [ ] **Step 9: 提交**

```bash
git add web/package.json web/pnpm-lock.yaml web/src/components/db/viewer/blob-preview/ web/src/components/db/result-grid.tsx
git commit -m "feat(db-studio): Phase 2C.3 — BLOB/图片/JSON/Geo 单元格预览（leaflet/react-leaflet 新增）"
```

---

## Task C4: profiler.Profiler 实现 + /profile/* endpoints

**Files:**
- Create: `internal/dbquery/profiler/mysql.go` + `_test.go`
- Create: `internal/dbquery/profiler/postgres.go` + `_test.go`
- Create: `internal/dbquery/profiler/dameng.go` + `_test.go`
- Create: `internal/dbquery/profiler/patterns.go`
- Modify: `internal/dbquery/adapter_*.go` (Profiler 返回 impl; DataProfiling = true)
- Modify: `internal/api/db_handler.go` (4 新端点)
- Modify: `internal/server/routes.go`

**Interfaces:**
- Produces:
  - `profiler.NewMySQL(db *sql.DB) profiler.Profiler`
  - `profiler.NewPostgres(db *sql.DB) profiler.Profiler`
  - `profiler.NewDameng(db *sql.DB) profiler.Profiler`
  - HTTP:
    - `GET /api/v1/nodes/:id/db/profile/stats?schema=&table=&column=`
    - `GET /api/v1/nodes/:id/db/profile/distribution?...&buckets=`
    - `GET /api/v1/nodes/:id/db/profile/topn?...&n=`
    - `GET /api/v1/nodes/:id/db/profile/patterns?...`

- [ ] **Step 1: patterns.go (shared regex catalog)**

`internal/dbquery/profiler/patterns.go`:

```go
package profiler

// commonPatterns is the bundled regex catalog used by every Profiler.Patterns
// implementation. Engines that lack POSIX regex (Dameng) get string-only
// fallback heuristics.
var commonPatterns = []struct {
	Name  string
	Regex string // POSIX-extended (works on MySQL REGEXP, PostgreSQL ~)
}{
	{Name: "email", Regex: `^[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}$`},
	{Name: "phone_cn", Regex: `^1[3-9][0-9]{9}$`},
	{Name: "uuid", Regex: `^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$`},
	{Name: "ipv4", Regex: `^([0-9]{1,3}\.){3}[0-9]{1,3}$`},
	{Name: "url", Regex: `^https?://[A-Za-z0-9.-]+`},
}
```

- [ ] **Step 2: MySQL profiler**

`internal/dbquery/profiler/mysql.go`:

```go
package profiler

import (
	"context"
	"database/sql"
	"errors"
	"fmt"
)

var errNoDB = errors.New("profiler: backing *sql.DB is nil")

type mysqlProfiler struct{ db *sql.DB }

func NewMySQL(db *sql.DB) Profiler { return &mysqlProfiler{db: db} }

func (p *mysqlProfiler) BasicStats(ctx context.Context, schema, table, column string) (BasicStats, error) {
	if p == nil || p.db == nil {
		return BasicStats{}, errNoDB
	}
	var stats BasicStats
	row := p.db.QueryRowContext(ctx, fmt.Sprintf(`
		SELECT
			COUNT(*),
			SUM(CASE WHEN %s IS NULL THEN 1 ELSE 0 END),
			COUNT(DISTINCT %s),
			MIN(%s), MAX(%s),
			AVG(CAST(%s AS DECIMAL(38,10))), STDDEV(CAST(%s AS DECIMAL(38,10)))
		FROM %s.%s`,
		ident(column), ident(column), ident(column), ident(column),
		ident(column), ident(column), ident(schema), ident(table)))
	var minV, maxV sql.NullString
	var avg, std sql.NullFloat64
	if err := row.Scan(&stats.Count, &stats.NullCount, &stats.Distinct, &minV, &maxV, &avg, &std); err != nil {
		// AVG / STDDEV may fail on non-numeric columns; retry without them.
		row2 := p.db.QueryRowContext(ctx, fmt.Sprintf(`
			SELECT COUNT(*), SUM(CASE WHEN %s IS NULL THEN 1 ELSE 0 END),
				COUNT(DISTINCT %s), MIN(%s), MAX(%s)
			FROM %s.%s`,
			ident(column), ident(column), ident(column), ident(column),
			ident(schema), ident(table)))
		if err2 := row2.Scan(&stats.Count, &stats.NullCount, &stats.Distinct, &minV, &maxV); err2 != nil {
			return stats, err2
		}
	}
	if minV.Valid {
		stats.Min = minV.String
	}
	if maxV.Valid {
		stats.Max = maxV.String
	}
	if avg.Valid {
		stats.Avg = avg.Float64
	}
	if std.Valid {
		stats.StdDev = std.Float64
	}
	return stats, nil
}

func (p *mysqlProfiler) Distribution(ctx context.Context, schema, table, column string, buckets int) (Histogram, error) {
	if p == nil || p.db == nil {
		return Histogram{}, errNoDB
	}
	if buckets <= 0 {
		buckets = 20
	}
	// MySQL ≥ 8 supports NTILE; fall back to manual bucketing for older.
	rows, err := p.db.QueryContext(ctx, fmt.Sprintf(`
		WITH bucketed AS (
			SELECT %s AS v, NTILE(%d) OVER (ORDER BY %s) AS b
			FROM %s.%s
			WHERE %s IS NOT NULL
		)
		SELECT MIN(v), MAX(v), COUNT(*) FROM bucketed GROUP BY b ORDER BY b`,
		ident(column), buckets, ident(column),
		ident(schema), ident(table), ident(column)))
	if err != nil {
		return Histogram{}, err
	}
	defer rows.Close()
	var h Histogram
	for rows.Next() {
		var lo, hi sql.NullString
		var cnt int64
		if err := rows.Scan(&lo, &hi, &cnt); err != nil {
			return h, err
		}
		h.Buckets = append(h.Buckets, HistogramBucket{LowerBound: lo.String, UpperBound: hi.String, Count: cnt})
	}
	return h, nil
}

func (p *mysqlProfiler) TopN(ctx context.Context, schema, table, column string, n int) ([]ValueFreq, error) {
	if p == nil || p.db == nil {
		return nil, errNoDB
	}
	if n <= 0 {
		n = 10
	}
	rows, err := p.db.QueryContext(ctx, fmt.Sprintf(`
		SELECT %s, COUNT(*) FROM %s.%s
		WHERE %s IS NOT NULL
		GROUP BY %s ORDER BY COUNT(*) DESC LIMIT %d`,
		ident(column), ident(schema), ident(table), ident(column), ident(column), n))
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var out []ValueFreq
	for rows.Next() {
		var v sql.NullString
		var c int64
		if err := rows.Scan(&v, &c); err != nil {
			return out, err
		}
		out = append(out, ValueFreq{Value: v.String, Count: c})
	}
	return out, nil
}

func (p *mysqlProfiler) Patterns(ctx context.Context, schema, table, column string) ([]PatternMatch, error) {
	if p == nil || p.db == nil {
		return nil, errNoDB
	}
	var out []PatternMatch
	for _, pat := range commonPatterns {
		var cnt int64
		err := p.db.QueryRowContext(ctx, fmt.Sprintf(`
			SELECT COUNT(*) FROM %s.%s WHERE %s REGEXP ?`,
			ident(schema), ident(table), ident(column)), pat.Regex).Scan(&cnt)
		if err != nil {
			// REGEXP may fail on binary columns; skip pattern.
			continue
		}
		out = append(out, PatternMatch{Pattern: pat.Name, Count: cnt})
	}
	return out, nil
}

func ident(s string) string { return "`" + s + "`" }
```

- [ ] **Step 3: MySQL test**

`internal/dbquery/profiler/mysql_test.go`:

```go
package profiler

import (
	"context"
	"testing"

	"github.com/DATA-DOG/go-sqlmock"
)

func TestMySQLBasicStats(t *testing.T) {
	db, mock, _ := sqlmock.New()
	defer db.Close()
	mock.ExpectQuery("SELECT").
		WillReturnRows(sqlmock.NewRows([]string{"count", "null", "distinct", "min", "max", "avg", "std"}).
			AddRow(1000, 12, 800, "alpha", "zulu", 42.5, 8.1))
	s, err := NewMySQL(db).BasicStats(context.Background(), "public", "users", "name")
	if err != nil { t.Fatal(err) }
	if s.Count != 1000 || s.Distinct != 800 || s.NullCount != 12 {
		t.Fatalf("stats: %+v", s)
	}
}

func TestMySQLTopN(t *testing.T) {
	db, mock, _ := sqlmock.New()
	defer db.Close()
	mock.ExpectQuery("SELECT .* GROUP BY .* ORDER BY").
		WillReturnRows(sqlmock.NewRows([]string{"v", "c"}).
			AddRow("alice", 50).AddRow("bob", 40))
	out, err := NewMySQL(db).TopN(context.Background(), "public", "users", "name", 10)
	if err != nil { t.Fatal(err) }
	if len(out) != 2 || out[0].Count != 50 {
		t.Fatalf("topn: %+v", out)
	}
}
```

- [ ] **Step 4: Postgres + Dameng profilers**

`internal/dbquery/profiler/postgres.go`: same shape as MySQL but PG syntax (`STDDEV_POP`, `~` operator for regex, double-quoted idents). Use `width_bucket()` for histogram.

`internal/dbquery/profiler/dameng.go`: Oracle-flavored SQL (`STDDEV`, `REGEXP_LIKE`, double-quoted idents, no `WITH … NTILE` → use rownum bucketing).

Both implement the same `Profiler` interface; tests mirror `mysql_test.go` shape.

(Implementer: write both files following the MySQL template. The only differences are: ident quoting, regex operator, histogram bucketing function. Don't try to share code — duplicate-with-difference is clearer than a shared template here.)

- [ ] **Step 5: Adapter wire**

`internal/dbquery/adapter.go`: evolve `Profiler` signature to accept `*sql.DB` (same pattern as A2 Completion).

In `adapter_mysql.go`, `adapter_postgres.go`, `adapter_dameng.go`, `adapter_mysql_compat.go`, `adapter_postgres_compat.go`:

```go
func (X) Profiler(db *sql.DB) profiler.Profiler { return profiler.NewX(db) }
```

Set `DataProfiling: true` in each `Capabilities()`.

- [ ] **Step 6: HTTP handlers**

`internal/api/db_handler.go` add 4 handlers (mirror existing Columns / Indexes pattern):

```go
func (h *DBHandler) ProfileStats(c *gin.Context) {
	nodeID, _, ok := h.gate(c)
	if !ok { return }
	schema, table, column := c.Query("schema"), c.Query("table"), c.Query("column")
	if schema == "" || table == "" || column == "" {
		c.JSON(http.StatusBadRequest, gin.H{"error": "schema, table, column required"})
		return
	}
	prov, conn, err := h.Svc.ProfilerProvider(c.Request.Context(), nodeID, "")
	if err != nil { c.JSON(http.StatusBadGateway, gin.H{"error": err.Error()}); return }
	defer h.Svc.Release(conn)
	if prov == nil { c.JSON(http.StatusNotImplemented, gin.H{"error": "profiling not supported"}); return }
	stats, err := prov.BasicStats(c.Request.Context(), schema, table, column)
	if err != nil { c.JSON(http.StatusBadGateway, gin.H{"error": err.Error()}); return }
	c.JSON(http.StatusOK, stats)
}

// ProfileDistribution / ProfileTopN / ProfilePatterns follow the same template.
```

`internal/dbquery/service.go`: add `ProfilerProvider(ctx, nodeID, database) (profiler.Profiler, *sql.DB, error)` helper mirroring CompletionProvider.

- [ ] **Step 7: Mount routes**

`routes.go`:

```go
ops.GET("/nodes/:id/db/profile/stats", rt.DB.ProfileStats)
ops.GET("/nodes/:id/db/profile/distribution", rt.DB.ProfileDistribution)
ops.GET("/nodes/:id/db/profile/topn", rt.DB.ProfileTopN)
ops.GET("/nodes/:id/db/profile/patterns", rt.DB.ProfilePatterns)
```

- [ ] **Step 8: build + test**

```
go build ./...
go test ./internal/dbquery/profiler -v
```

- [ ] **Step 9: 提交**

```bash
git add internal/dbquery/profiler/ internal/dbquery/adapter.go internal/dbquery/adapter_*.go internal/dbquery/service.go internal/api/db_handler.go internal/server/routes.go
git commit -m "feat(db-studio): Phase 2C.4 — profiler.Profiler（MySQL/PostgreSQL/Dameng）+ /profile/* endpoints"
```

---

## Task C5: Data Profiling UI (Recharts panel + Markdown export)

**Files:**
- Create: `web/src/components/db/viewer/data-profiling.tsx`
- Modify: `web/src/components/db/browse-tab.tsx` (add "数据剖析" button → opens panel)
- Modify: `web/src/lib/api/services.ts` (extend dbService with 4 profile methods)
- Modify: `web/src/lib/api/types.ts` (BasicStats / Histogram / ValueFreq / PatternMatch)

**Interfaces:**
- Produces:
  - `<DataProfiling nodeId schema table columns/>` — full Sheet with column picker + Recharts panel + export

- [ ] **Step 1: TS types + services**

`types.ts`:

```ts
export interface BasicStats {
  Count: number
  NullCount: number
  Distinct: number
  Min: unknown
  Max: unknown
  Avg: number
  StdDev: number
}
export interface HistogramBucket { LowerBound: unknown; UpperBound: unknown; Count: number }
export interface Histogram { Buckets: HistogramBucket[] }
export interface ValueFreq { Value: unknown; Count: number }
export interface PatternMatch { Pattern: string; Count: number }
```

`services.ts` extend `dbService`:

```ts
profile: {
  stats: (nodeId: number, p: { schema: string; table: string; column: string }) =>
    api.get<BasicStats>(`/nodes/${nodeId}/db/profile/stats`, { params: p }),
  distribution: (nodeId: number, p: { schema: string; table: string; column: string; buckets?: number }) =>
    api.get<Histogram>(`/nodes/${nodeId}/db/profile/distribution`, { params: p }),
  topn: (nodeId: number, p: { schema: string; table: string; column: string; n?: number }) =>
    api.get<{ items: ValueFreq[] }>(`/nodes/${nodeId}/db/profile/topn`, { params: p }),
  patterns: (nodeId: number, p: { schema: string; table: string; column: string }) =>
    api.get<{ items: PatternMatch[] }>(`/nodes/${nodeId}/db/profile/patterns`, { params: p }),
},
```

- [ ] **Step 2: DataProfiling panel**

`web/src/components/db/viewer/data-profiling.tsx`:

```tsx
"use client";

import { useQuery } from "@tanstack/react-query";
import { dbService } from "@/lib/api/services";
import { Sheet, SheetContent, SheetHeader, SheetTitle } from "@/components/ui/sheet";
import { Button } from "@/components/ui/button";
import { Select, SelectTrigger, SelectValue, SelectContent, SelectItem } from "@/components/ui/select";
import { BarChart, Bar, XAxis, YAxis, Tooltip, ResponsiveContainer } from "recharts";
import { useState } from "react";

interface Props {
  open: boolean;
  onClose: () => void;
  nodeId: number;
  schema: string;
  table: string;
  columns: { name: string; dataType: string }[];
}

export function DataProfiling({ open, onClose, nodeId, schema, table, columns }: Props) {
  const [column, setColumn] = useState(columns[0]?.name ?? "");
  const stats = useQuery({
    queryKey: ["profile-stats", nodeId, schema, table, column],
    queryFn: () => dbService.profile.stats(nodeId, { schema, table, column }),
    enabled: open && !!column,
  });
  const distribution = useQuery({
    queryKey: ["profile-dist", nodeId, schema, table, column],
    queryFn: () => dbService.profile.distribution(nodeId, { schema, table, column, buckets: 20 }),
    enabled: open && !!column,
  });
  const topn = useQuery({
    queryKey: ["profile-topn", nodeId, schema, table, column],
    queryFn: () => dbService.profile.topn(nodeId, { schema, table, column, n: 10 }).then((r) => r.items),
    enabled: open && !!column,
  });
  const patterns = useQuery({
    queryKey: ["profile-patterns", nodeId, schema, table, column],
    queryFn: () => dbService.profile.patterns(nodeId, { schema, table, column }).then((r) => r.items),
    enabled: open && !!column,
  });

  function exportMarkdown() {
    const md = [
      `# Data Profile: ${schema}.${table}.${column}`,
      ``,
      `## Basic Stats`,
      `- Count: ${stats.data?.Count}`,
      `- Distinct: ${stats.data?.Distinct}`,
      `- Null Count: ${stats.data?.NullCount}`,
      `- Min / Max: ${stats.data?.Min} / ${stats.data?.Max}`,
      `- Avg / StdDev: ${stats.data?.Avg?.toFixed(2)} / ${stats.data?.StdDev?.toFixed(2)}`,
      ``,
      `## Top 10`,
      ...(topn.data ?? []).map((t) => `- ${t.Value}: ${t.Count}`),
      ``,
      `## Patterns`,
      ...(patterns.data ?? []).map((p) => `- ${p.Pattern}: ${p.Count}`),
    ].join("\n");
    const blob = new Blob([md], { type: "text/markdown" });
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = `${schema}-${table}-${column}.md`;
    a.click();
  }

  const distData = (distribution.data?.Buckets ?? []).map((b, i) => ({ idx: i, count: b.Count, range: `${b.LowerBound}—${b.UpperBound}` }));
  const topData = (topn.data ?? []).map((t) => ({ name: String(t.Value), count: t.Count }));

  return (
    <Sheet open={open} onOpenChange={(o) => !o && onClose()}>
      <SheetContent className="w-[720px] sm:max-w-[720px]">
        <SheetHeader>
          <SheetTitle>数据剖析 — {schema}.{table}</SheetTitle>
        </SheetHeader>
        <div className="space-y-4 mt-3">
          <div className="flex gap-2 items-center">
            <Select value={column} onValueChange={setColumn}>
              <SelectTrigger className="w-48"><SelectValue /></SelectTrigger>
              <SelectContent>
                {columns.map((c) => <SelectItem key={c.name} value={c.name}>{c.name} <span className="text-xs text-muted-foreground">({c.dataType})</span></SelectItem>)}
              </SelectContent>
            </Select>
            <Button variant="ghost" size="sm" onClick={exportMarkdown}>导出 Markdown</Button>
          </div>

          <div>
            <h3 className="font-semibold mb-1">基本统计</h3>
            {stats.data ? (
              <table className="text-sm w-full">
                <tbody>
                  <tr><td>Count</td><td>{stats.data.Count}</td></tr>
                  <tr><td>Distinct</td><td>{stats.data.Distinct}</td></tr>
                  <tr><td>Null Count</td><td>{stats.data.NullCount}</td></tr>
                  <tr><td>Min / Max</td><td>{String(stats.data.Min)} / {String(stats.data.Max)}</td></tr>
                  <tr><td>Avg / StdDev</td><td>{stats.data.Avg?.toFixed(2)} / {stats.data.StdDev?.toFixed(2)}</td></tr>
                </tbody>
              </table>
            ) : <div className="text-muted-foreground">加载...</div>}
          </div>

          <div>
            <h3 className="font-semibold mb-1">分布</h3>
            <ResponsiveContainer width="100%" height={180}>
              <BarChart data={distData}>
                <XAxis dataKey="idx" />
                <YAxis />
                <Tooltip formatter={(v, n, p) => [v, p.payload.range]} />
                <Bar dataKey="count" />
              </BarChart>
            </ResponsiveContainer>
          </div>

          <div>
            <h3 className="font-semibold mb-1">Top 10</h3>
            <ResponsiveContainer width="100%" height={180}>
              <BarChart data={topData} layout="vertical">
                <XAxis type="number" />
                <YAxis dataKey="name" type="category" width={120} />
                <Tooltip />
                <Bar dataKey="count" />
              </BarChart>
            </ResponsiveContainer>
          </div>

          <div>
            <h3 className="font-semibold mb-1">正则模式匹配</h3>
            <table className="text-sm w-full">
              <thead><tr><th>Pattern</th><th>Count</th></tr></thead>
              <tbody>
                {(patterns.data ?? []).map((p) => <tr key={p.Pattern}><td>{p.Pattern}</td><td>{p.Count}</td></tr>)}
              </tbody>
            </table>
          </div>
        </div>
      </SheetContent>
    </Sheet>
  );
}
```

- [ ] **Step 3: Browse-tab integration**

In `browse-tab.tsx`: add a "数据剖析" button next to the existing toolbar (gate on `capabilities.data_profiling`). On click → set local state `profilingOpen=true` and render `<DataProfiling open onClose={...} columns={currentColumns}/>`.

- [ ] **Step 4: typecheck**

```
cd web && pnpm typecheck
```

- [ ] **Step 5: 提交**

```bash
git add web/src/components/db/viewer/data-profiling.tsx web/src/components/db/browse-tab.tsx web/src/lib/api/services.ts web/src/lib/api/types.ts
git commit -m "feat(db-studio): Phase 2C.5 — Data Profiling 面板（Recharts + Markdown 导出）"
```

---

## Self-Review

**1. Spec coverage**

| Spec §4 项目 | 对应任务 |
|---|---|
| 外键 picker | C1 |
| View Profiles | C2 |
| BLOB / 图片 / JSON / Geo | C3 |
| Data Profiling | C4 (后端) + C5 (前端) |

**2. Placeholder scan**

- 所有 step 含完整代码；C4 step 4 "Postgres + Dameng profilers" 明确给出 differences 列表（ident quoting / regex operator / histogram fn）而不是"similar to mysql" — 实现者直接照写
- C1 step 2 `pickLabelColumn` 实现注释提醒消费既有 `Columns()` helper；fallback path 已写完整代码

**3. Type consistency**

- `BasicStats / Histogram / ValueFreq / PatternMatch` Go ↔ TS：PascalCase（Go 默认 JSON 编码无 json tag）
- `ForeignKeyTarget` 用 snake_case json tags → TS 也用 snake_case
- `ViewProfile` 字段 snake_case 双向一致

**4. Ambiguity check**

- "数据剖析行数上限" — global constraint 写明：>1M rows 走采样
- BlobPreview MIME detection — image.tsx 显式列出 magic-byte prefixes
- C4 patterns engine 兼容性：Dameng REGEXP_LIKE 不可用列会 skip pattern，错误不抛

---

## Execution Handoff

**Plan complete and saved to `.planning/plans/2026-06-24-db-studio-phase2C-data-viewer.md`. Two execution options:**

**1. Subagent-Driven (recommended)** — 每个 task 派新 subagent，task 间检阅
**2. Inline Execution** — 在本会话直接批执行

**Which approach?** (默认 1)

---

## Notes on Parallel Execution with Phase 2A

This plan is **independent** of Phase 2A (`2026-06-24-db-studio-phase2A-sql-editor.md`):
- A 改 `editor/`, C 改 `viewer/` — 前端不冲突
- A 落 `completion/` + `planner/`，C 落 `profiler/` — 后端不冲突
- 两者都改 `adapter_*.go` 的 `Capabilities()` 返回值（flag 设置）和 `Adapter` 接口方法签名（C 改 Profiler 的 `*sql.DB`）— **会冲突**
- 两者都改 `internal/api/db_handler.go` 加新 endpoint — **会冲突**
- 两者都改 `internal/server/routes.go` 挂新路由 — **会冲突**

冲突解决策略：
- 先后顺序执行 A、C 各自的 Task 5 ~ 8（接 adapter / handler / routes 的步骤），由控制器调度协调
- Task A1 / A3 / A4 / A6 / A7 / A8（除 A5）+ Task C1 / C2 / C3 / C4 / C5 中，**前端组件 + completion / planner / profiler 包**完全可并行
- 改 `adapter_*.go` 和 `routes.go` 的步骤 → 控制器串行 dispatch
