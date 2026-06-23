# Task 7 Report — 前端 shared/ 骨架 + 子模块目录 + DBCapabilities 类型同步

**Status:** ✅ COMPLETE
**Commit:** `6a0f790f310e55a3a21f29845c840a8e330e9a7c`
**Commit message:** `feat(db-studio): Phase 1.7 — 前端 shared/ 骨架 + 6 子模块目录 + DBCapabilities 7 字段`
**Typecheck:** ✅ PASS (`cd web && pnpm typecheck` → `tsc --noEmit`, exit 0)

## Files delivered (11)

### New (9)
- `web/src/components/db/shared/schema-cache.ts` — `schemaCacheKey()` + `useSchemaSnapshot()` (TanStack Query, 5min TTL)
- `web/src/components/db/shared/ddl-renderer.tsx` — `<DDLRenderer>` via `@monaco-editor/react` (`Editor`/`DiffEditor`, read-only)
- `web/src/components/db/shared/react-flow-canvas.tsx` — Phase 1 stub (`<ReactFlowCanvas>`)
- `web/src/components/db/editor/index.ts` — placeholder (`export {}`)
- `web/src/components/db/designer/index.ts` — placeholder
- `web/src/components/db/viewer/index.ts` — placeholder
- `web/src/components/db/connection/index.ts` — placeholder
- `web/src/components/db/builder/index.ts` — placeholder
- `web/src/components/db/modeler/index.ts` — placeholder

### Modified (2)
- `web/src/lib/api/services.ts` — added `dbService.completionSnapshot` + new `dbStudioService.parseUri`
- `web/src/lib/api/types.ts` — added 7 fields to `DBCapabilities` after `vendor_label?`

## Brief corrections applied (all 6)
1. ❌ Dropped `schema-cache.test.ts` — no `vitest`/no `test` script in `package.json`. Contract enforced via TS types + JSDoc.
2. ✅ Used `@monaco-editor/react` (`{ DiffEditor, Editor }`) — NOT raw `monaco-editor.createDiffEditor`.
3. ✅ `ReactFlowCanvas` shipped as stub — `react-flow` not a dependency in Phase 1.
4. ✅ Added only the 7 new fields; existing fields (incl. `database_scope: "catalog" | "schema"` literal union) untouched.
5. ✅ **Git hygiene**: user's unrelated WIP in `types.ts` (a `| "desktop"` removal at L276, ~100 lines from my edit) was staged-out via `git add -p` (`y`/`n`). Verified `git diff --cached` showed only my 10 insertions; WIP preserved unstaged in working tree.
6. ✅ `schemaCacheKey` returns `["schema-snapshot", nodeId, database || "__default__"]`; `useQuery` uses `Omit<UseQueryOptions<SchemaSnapshot>, "queryKey" | "queryFn">`.

## DBCapabilities — 7 new fields
```ts
object_designer: string      // CSV of ObjectKindSet (e.g. "table,view,index")
visual_query_plan: boolean
data_profiling: boolean
schema_completion: boolean
er_model: boolean
pinned_results: boolean
visual_builder: boolean
```

## dbStudioService.parseUri
PascalCase field names match the Go `ConnectionURI` struct in `internal/dbstudio/connections.go` (no json tags → Gin marshals exported names verbatim): `Scheme, Host, Port, Database, User, Password, Params`. Endpoint: `POST /dbstudio/connections/parse-uri`.

## Verification
- `git show --stat HEAD` → 11 files, +155 −1 (the −1 is a services.ts brace-boundary diff artifact; structure verified correct, typecheck clean).
- `package.json` NOT in commit → **no new npm deps** (`@monaco-editor/react` ^4.7.0, `@tanstack/react-query` ^5.101.0 already present).
- `git show HEAD -- types.ts` → only `+` lines, zero `-` → **user WIP not bundled**.

## Non-goals (correctly deferred)
- Concrete UI screens (sub-projects A–F fill the 6 module dirs).
- `react-flow` integration (sub-project E/F).
- Backend `completionSnapshot` route wiring (sub-project A).
- Dialect-aware SQL highlighting in DDLRenderer (sub-project B).

## Fix: ObjectKindSet JSON wire-format

**Status:** ✅ DONE
**Commit:** `1fc8605`
**Commit message:** `fix(db-studio): ObjectKindSet 加 MarshalJSON/UnmarshalJSON（CSV 序列化对齐前端契约）`

**Files changed (2):**
- `internal/dbquery/object_kind.go` — added `MarshalJSON()` (emits CSV string) + `UnmarshalJSON()` (parses CSV back), imports `encoding/json` + `fmt`
- `internal/dbquery/object_kind_test.go` — added `TestObjectKindSetJSONRoundTrip` (4 round-trip cases: empty, single, multiple, all) + `TestObjectKindSetUnmarshalUnknown` (verifies error on unknown kind)

**Test names + PASS counts:**
- `TestObjectKindSetJSONRoundTrip` — 4 sub-tests (empty, single, multiple, all)
- `TestObjectKindSetUnmarshalUnknown` — 1 sub-test
- Total: 5 sub-tests, all PASS

**Verification commands:**
- `go test ./internal/dbquery -run TestObjectKindSet -v` → `go test: 1 packages ok` (PASS)
- `go build ./...` → PASS (no output, 1 packages ok)
- `gofmt -l internal/dbquery/object_kind.go internal/dbquery/object_kind_test.go` → no output (clean)
