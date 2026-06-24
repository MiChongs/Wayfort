# W1 — Adapter 能力族 wire（Completion / Planner / Profiler）+ 6 endpoints

## Status: ✅ DONE — build clean, tests green

## Files changed (8)
| File | Change |
|---|---|
| `internal/dbquery/adapter.go` | Adapter 接口演进：`Planner/Profiler/Completion(db *sql.DB)`；import +`database/sql` |
| `internal/dbquery/adapter_mysql.go` | 3 签名 → `NewMySQL(db)`；3 capability flag = true |
| `internal/dbquery/adapter_postgres.go` | 3 签名 → `NewPostgres(db)`；3 flag |
| `internal/dbquery/adapter_dameng.go` | 3 签名 → `NewDameng(db)`；3 flag |
| `internal/dbquery/adapter_mysql_compat.go` | 3 签名 → `NewMySQL(db)`（family 继承）；3 flag 赋值 |
| `internal/dbquery/adapter_postgres_compat.go` | 3 签名 → `NewPostgres(db)`；3 flag 赋值 |
| `internal/dbquery/service.go` | +3 helper：`CompletionProvider/PlannerProvider/ProfilerProvider`（复用 getOrOpen + adapterForPool）|
| `internal/api/db_capability_handler.go` | **新建**：6 handler（Snapshot/Plan/Stats/Distribution/TopN/Patterns）+ planBody + profileParams |
| `internal/api/db_handler_test.go` | +3 smoke test（NilSvc → 503）|
| `internal/server/routes.go` | 挂载 6 路由（ops group）|
| `internal/dbquery/adapter_test.go` | family 测试调用改 `Planner/Profiler/Completion(nil)` |

## 关键设计决策（偏离 brief，有据）
1. **Helper 签名加 `userID`**：brief 写 `(ctx, nodeID, database)`，但既有 `getOrOpen(ctx, nodeID, userID, database)` 必须传 userID（access check + pool key）。故 helper 签名对齐既有 `LoadColumnStats/Query/Exec` 为 `(ctx, nodeID, userID, database)`，保持审计边界一致。
2. **不新增 `Release(conn)`**：既有 pool 架构里 `*sql.DB` 是共享池（存于 `s.pools`，由 `RunEvictor` 回收），无 per-call 归还。brief 的 `defer Release(conn)` 与架构不符，handler 直接 `_, err :=` 忽略返回的 conn（provider 内部已持有）。与 Schema/Columns/LoadColumnStats 路径一致。
3. **6 handler 放新文件 `db_capability_handler.go`**：`db_handler.go` 已 1181 行（远超 ≤400 行硬规则），新增会恶化。handler 是 `*DBHandler` 方法，可放任意同包文件；新文件 ~210 行，满足 ≤400。仍为 `*DBHandler` 接收者。

## 验证
- Adapter 接口演进确认：`Planner(db *sql.DB) / Profiler(db *sql.DB) / Completion(db *sql.DB)` ✓
- 6 endpoints 挂载：completion/snapshot · plan · profile/{stats,distribution,topn,patterns} ✓
- 3 capability flags × 5 adapter = 15 flag 更新 ✓（grep 复核）
- 3 签名 × 5 adapter = 15 方法更新 ✓（grep 复核）
- **Build**：`go build ./...` clean
- **gofmt**：所改 11 文件全部 clean（其余 internal/ 文件为既有未格式化，未触碰）
- **Tests**：
  - `TestAllAdaptersImplementNewCapabilityFamilies` PASS（5 adapter × family 不 panic）
  - 3 新 smoke test PASS（RED→GREEN：handler 先不存在→实现后 503）
  - `./internal/dbquery/...` 全 PASS（dbquery/completion/planner/profiler/designer/modeler）
  - DB 区全部 PASS（DBStudio + IsReadOnlySQL + SQLHead）
  - 注：`internal/api` 中 `agent_*_test.go` 的 CGO/sqlite3 失败为**既有环境问题**（CGO_ENABLED=0），与本次改动无关
- 新增测试数：3
