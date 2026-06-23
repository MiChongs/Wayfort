# Db Studio · Navicat 平替 设计规约

- 日期：2026-06-23
- 状态：Design (Spec)
- 范围：Wayfort Db Studio 全功能升级，对标 Navicat 17 核心 80%
- 后续：本 spec 通过后，按 §12 路线图为每个子项目（A–F）各开一份实施 plan

---

## 0. 背景与范围

### 0.1 当前现状（事实快照）

**后端 (`internal/dbquery/` + `internal/api/db_handler.go`)**

- 适配器架构（Phase 1-2 迁移中）：MySQL / PostgreSQL / Dameng + 兼容引擎（TiDB、OceanBase、StarRocks、Doris、GBase 8a/8s、GaussDB）
- 国产 native：HighGo / Kingbase / Vastbase / OceanBase（部分实现），其余占位待实现
- REST API：`ping / engines / capabilities / databases / schema / columns / indexes / foreign_keys / stats / ddl / rows / query / exec / explain / row_update / insert / delete / processes / kill`

**前端 (`web/src/components/db/`)**

- 根容器按 `DBCapabilities` 条件渲染 Browse / Structure / SQL Editor / Processes
- ResultGrid：Grid / Form / Hex / Note 视图 + CSV/JSONL/SQL/Markdown/Excel 导出
- SQL Editor：Monaco + localStorage 历史 + saved queries（无服务端持久化）
- Schema 树：搜索 + 列表虚拟化

### 0.2 范围（In-Scope / Out-of-Scope）

| 子项目 | In-Scope | Out-of-Scope |
|---|---|---|
| A · SQL 编辑器 | schema-aware 补全、SQL 美化、Pinned Results、saved queries 服务端化、可视化执行计划（Tree/JSON/Text + 高耗算子高亮）、查询历史服务端化 | SQL 调试器断点单步、AI 助手 |
| B · 对象设计器 | 表 / 视图 / 函数 / 存储过程 / 触发器 / 事件 / 索引 / 序列 8 类对象的可视化设计器 + DDL diff 预览 + 一键 apply | 用户 / 角色 / 权限 / 表空间 / 链接服务器（仍用 SQL） |
| C · 数据查看器 | 外键 picker、筛选/排序 profile 持久化（多套切换）、BLOB/图片/JSON/地理空间查看、Data Profiling（统计/分布/Top-N/正则模式） | 全文搜索引擎风格的查找替换 |
| D · 连接 & 数据源 | MongoDB + Redis 协议族、URI 快连、颜色标记、连接分组、虚拟组、连接复制 | Snowflake / Redshift（仅留 capability flag）、HTTP 隧道、各家云厂商专用链接器 |
| E · 可视化查询构建器 | 拖拽表 / join / 条件 / 分组 / 排序 → SQL，与编辑器双向同步 | SQL 调试器断点 |
| F · 数据建模 | ER 图设计器 + 逆向工程（DB→模型）+ 正向工程（模型→DDL）+ 模型↔DB 同步对比；**仅物理模型** | 逻辑/概念模型、Data Vault 2.0、维度建模、ODBC 导入 |

### 0.3 设计原则

- **复用既有适配器系统**：与 Phase 2 迁移同向，不返工
- **协议双轨**：关系型与 NoSQL 不共享面板，避免虚假统一抽象
- **能力 gate**：每个新能力以 `Capabilities` flag 通报，前端按能力降级
- **隔离边界**：6 个子项目各自有独立目录与 owner，便于并行开发
- **测试先行**：每个新接口族都有契约测试，DDL/查询生成走 golden file

---

## 1. 总体架构

### 1.1 后端分层

```
internal/
├── dbquery/                       # 既有：底层适配器与连接池
│   ├── adapter.go                 # Adapter 契约（扩 5 接口族）
│   ├── adapter_{mysql,postgres,dameng,...}.go
│   ├── designer/                  # 新：对象设计器 DDL gen（每 dialect 一份）
│   ├── planner/                   # 新：EXPLAIN 输出 → 统一 PlanNode 树
│   ├── profiler/                  # 新：Data Profiling SQL 模板
│   ├── completion/                # 新：schema cache + 补全 hint provider
│   ├── modeler/                   # 新：DDL parse(IR) + IR→DDL（ER 用）
│   ├── nosql/                     # 新：协议双轨第二轨
│   │   ├── mongo/                 #   MongoDB adapter（CRUD/agg/index）
│   │   └── redis/                 #   Redis adapter（key/cmd browser）
│   └── native/                    # 既有：国产 driver
└── dbstudio/                      # 新：跨子项目业务编排
    ├── saved_queries.go           # 服务端 saved queries
    ├── pinned_results.go          # 结果快照存储
    ├── view_profiles.go           # 表筛选/排序/列 profile
    ├── data_profile.go            # Data Profiling 任务编排
    ├── connections.go             # 分组/颜色/虚拟组/URI 解析
    ├── er_model.go                # ER 模型存储 + 正/逆向工程编排
    └── object_apply.go            # DDL diff 计算 + 审批 + apply
```

### 1.2 Adapter 契约扩展（`internal/dbquery/adapter.go`）

```go
type Adapter interface {
    Protocol() Protocol
    Family() Family
    Capabilities() Capabilities
    Dialect() Dialect

    // 新增 5 个能力族（不支持返回 nil → 前端 capability gate 关闭）
    Designer()   designer.Designer
    Planner()    planner.Planner
    Profiler()   profiler.Profiler
    Completion() completion.Provider
    Modeler()    modeler.Modeler
}

type Capabilities struct {
    // 既有字段保留 ...

    ObjectDesigner   ObjectKindSet // bitmask: table|view|func|proc|trigger|event|index|sequence
    VisualQueryPlan  bool
    DataProfiling    bool
    SchemaCompletion bool
    ERModel          bool
    PinnedResults    bool
    VisualBuilder    bool
}

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
```

### 1.3 前端模块拆分（`web/src/components/db/`）

```
db/
├── shared/                          # 跨子项目共享
│   ├── capability-gate.tsx
│   ├── schema-cache.ts              # 新：schema cache + 订阅
│   ├── ddl-renderer.tsx             # 新：DDL 高亮 + diff
│   └── react-flow-canvas.tsx        # 新：ER 图 / 查询构建器共享 canvas
├── editor/                          # A
├── designer/                        # B
├── viewer/                          # C
├── connection/                      # D
├── builder/                         # E
└── modeler/                         # F
```

### 1.4 协议双轨

- **关系轨**：`Adapter` 接口 + SQL → `internal/api/db_handler.go`（既有路由扩展）
- **NoSQL 轨**：`nosql.Adapter` 接口（与关系型同顶层 `Family` 字段区分）+ 协议族原生命令 → `internal/api/db_nosql_handler.go`（新）

前端 `DBStudio` 根据 `Family` 路由到关系型 shell 或 NoSQL shell。**关系型/NoSQL 不共享面板**，避免抽象出虚假统一性。

---

## 2. A · SQL 编辑器升级

### 2.1 schema-aware 补全

- 后端：`completion.Provider` 在适配器内提供 `Schemas() / Tables(schema) / Columns(table) / Functions() / Keywords()`
- 前端：`schema-cache.ts` 在 React Query 之上加 TTL=5min 缓存，DDL 变更后失效
- Monaco 注册 `CompletionItemProvider`，按光标上下文：
  - `SELECT a.|` → 解析 `a` 别名 → 给对应表的 columns
  - `FROM |` → tables
  - 关键字位置 → keywords
- AST 上下文识别用 `node-sql-parser`（轻量、纯 JS、支持多方言）

### 2.2 SQL 美化

- 纯前端：`sql-formatter` npm 包 + 自有 wrapper 处理 dialect 切换
- 入口：编辑器工具栏「美化」按钮 + 快捷键 `Shift+Alt+F`

### 2.3 Pinned Results

- DB schema：`pinned_results(id, owner_id, node_id, sql, params_json, executed_at, rowcount, snapshot_arrow, ttl)`
- snapshot：Arrow IPC 格式（行列存储紧凑、零拷贝读取）
- 上限：10MB / 50k 行（超限截断 + 标记 `truncated:true`）
- UI：`editor/pinned-results.tsx`，时间轴 + 两 pin 并排 diff 视图

### 2.4 Saved Queries 服务端化

- DB schema：`saved_queries(id, owner_id, name, folder_path, sql, params_json, shared_scope, updated_at)`
  - `shared_scope ∈ {user, team, node}`
  - `folder_path` 类树形（"engineering/auth/login.sql"）
- 迁移：前端启动时将 `localStorage` 中 saved queries 一次性 push 到后端，本地清空
- 共享权限：与既有节点权限模型对齐

### 2.5 可视化执行计划

- 后端 `planner.Planner`：
  - MySQL：`EXPLAIN FORMAT=TREE` + `EXPLAIN FORMAT=JSON` 双输出 → `PlanNode{Op, Table, Rows, Cost, ChildIdx[], Warnings[]}`
  - PostgreSQL：`EXPLAIN (FORMAT JSON, ANALYZE OFF) ...` 直接解析
  - Dameng：`EXPLAIN PLAN FOR ...` + `SELECT * FROM PLAN_TABLE`
- 前端 `editor/execution-plan/`：
  - `plan-tree.tsx`：React Flow 渲染树形节点；按 cost 高亮（`>20%` 总成本 红色，`10-20%` 黄色）
  - Tab 切 Tree / JSON / Text / Statistics

### 2.6 查询历史服务端化

- DB schema：`query_history(id, owner_id, node_id, sql, params_json, executed_at, duration_ms, rowcount, status, error_text)`
- 按 owner 隔离；保留 30 天（cron purge）
- UI：编辑器侧栏「History」tab，搜索 + 时间筛选 + 一键重放

---

## 3. B · 对象设计器

### 3.1 通用模型

- 每类对象有 IR struct（`designer/table.go::TableSpec` 等），由 `designer.Designer` 生成 dialect SQL
- 前端 `designer/<kind>-designer/` 是多 tab 表单 + 实时 DDL 预览
- 应用流程：

```
load(existing) → edit IR → diff(IR_new, IR_old) → 生成 ALTER/CREATE SQL
→ 安全门检查 → 审批 → apply（事务执行 + 审计）
```

### 3.2 8 类对象 tab 矩阵

| 对象 | Tabs |
|---|---|
| Table | Columns / Indexes / FKs / Triggers / Options / Comment / SQL Preview |
| View | Definition / Options / SQL Preview |
| Function | Signature / Body / Options / SQL Preview |
| Procedure | Signature / Body / Options / SQL Preview |
| Trigger | Trigger Event / Timing / Body / SQL Preview |
| Event | Schedule / Body / Options / SQL Preview |
| Index | Columns / Method / Options / SQL Preview |
| Sequence | Range / Cycle / Options / SQL Preview |

### 3.3 DDL Diff & Apply

- `internal/dbstudio/object_apply.go`：
  - `Diff(oldIR, newIR) → []Change{Op, Element, SQL}`，`Op ∈ {Add, Drop, Modify}`
  - 单 transaction 渲染（MySQL 部分 DDL 不可回滚 → 显式警告 `non-transactional:true`）
  - 复用既有 `db_handler.go` 安全门：白名单 op 列表 + 审计写入
- 前端 `designer/ddl-diff-panel.tsx`：左右并排 + 高亮变更行 + 「Copy SQL / Run」按钮

### 3.4 引擎能力差异

- **MySQL**：8 类全支持
- **PostgreSQL**：8 类全支持（function/procedure 区分清晰）
- **Dameng**：Oracle 语法 → Event 映射到 Job、Sequence 支持；Trigger 语法差异在 `designer/dameng.go` 吸收
- **其他兼容引擎**：默认走父 dialect designer，能力 bitmask 缺项前端 disable

---

## 4. C · 数据查看器增强

### 4.1 外键 Picker

- 后端 `db_handler.go::ForeignKeyTargets(table, column)` 新端点：返回引用表 + 列 + 候选行查询 SQL
- 前端 `viewer/foreign-key-picker.tsx`：Sheet 弹窗，候选行 lazy 列表 + 搜索 + 选中回填，复用 `ResultGrid`

### 4.2 View Profiles（多套筛选/排序/列配置）

- DB schema：`view_profiles(id, owner_id, node_id, table_fqn, name, filter_json, sort_json, columns_json, is_default, updated_at)`
- 前端：表头条新增 profile dropdown「默认 / Profile A / Profile B / + 新建」
- 切换 profile 立即套用 filter/sort/columns

### 4.3 BLOB / 图片 / JSON / 地理空间

- 单元格点击 → `viewer/blob-preview/` 弹窗按 MIME / 字段类型路由：
  - **图片**：直接 `<img src=data:...>`，>5MB 走流式 `/cell?download=1`
  - **JSON**：折叠 tree view + 编辑回写
  - **Geo**：Leaflet（GeoJSON / WKT 解析）
  - **二进制**：hex view（既有）
- 字段类型识别：列元数据 + 内容嗅探（PNG / JPG / GIF magic bytes）

### 4.4 Data Profiling（数据剖析）

- 后端 `profiler.Profiler` 每 dialect 提供：
  - `BasicStats(table, col)` → count / null / distinct / min / max / avg / stddev
  - `Distribution(table, col, buckets)` → 直方图
  - `TopN(table, col, n)` → 高频值
  - `Patterns(table, col)` → 正则模式聚合（email / phone / uuid 等）
- 前端 `viewer/data-profiling.tsx`：行选中 + 选列 → 生成报告 panel（Recharts 图表）+ 一键导出 Markdown

---

## 5. D · 连接 & 数据源（含 NoSQL）

### 5.1 连接分组 / 颜色 / 虚拟组

- 节点系统已有 → 在 `nodes` 表加 `db_color`, `db_group_path`, `db_virtual_groups[]`
- 前端 `connection/connection-tree.tsx`：拖拽分组、颜色环染、虚拟组 view 切换

### 5.2 URI 快连

- 前端 dialog：粘 `mysql://user:pwd@host:3306/db?ssl=true` → 解析 → 预填创建节点表单
- 后端 `internal/dbstudio/connections.go::ParseURI(string)`，统一解析为 `NodeCreate` payload
- 支持协议：mysql / postgresql / mongodb / redis / dameng / oceanbase / tidb / ...

### 5.3 MongoDB（文档）

- 后端 `nosql/mongo/adapter.go`：driver = `go.mongodb.org/mongo-driver/v2`
- API（新路由组 `/nodes/:id/mongo/*`）：
  - `databases`, `collections(db)`, `documents(db, coll, filter, sort, page)`
  - `findOne`, `insertOne`, `updateOne`, `deleteOne`, `aggregate(pipeline)`
  - `indexes`, `createIndex`, `serverStatus`
- 前端 `connection/mongo-browser.tsx`：
  - 左侧库 / 集合树
  - 右侧 document grid（JSON view + Tree view 双模式）
  - 顶部 query bar：`{filter}` + sort + projection + page
  - Aggregation Pipeline 编辑器（stage 拖拽 + JSON）

### 5.4 Redis（KV）

- 后端 `nosql/redis/adapter.go`：driver = `github.com/redis/go-redis/v9`
- API（新路由组 `/nodes/:id/redis/*`）：
  - `dbs`, `keys(pattern, scan_cursor)`, `get(key)`, `set(key, val, type)`
  - `del`, `type`, `ttl`, `expire`, `info`, `clientList`, `slowlog`
- 前端 `connection/redis-browser.tsx`：
  - 左侧 db (0-15) + key tree（按 `:` 分隔虚拟分组）
  - 右侧按 type 路由：string / hash / list / set / zset / stream 各自专属编辑器
  - 顶部 SCAN 分页 + pattern 搜索

---

## 6. E · 可视化查询构建器

- 前端 `builder/visual-query-builder.tsx`：React Flow canvas
- 节点种类：`TableNode`（拖入 schema tree 的表），`ConditionNode`，`GroupByNode`，`OrderByNode`，`OutputNode`
- 边：表↔表 = join（中段点击切 join 类型 INNER / LEFT / RIGHT / FULL；inline 条件编辑）
- 右抽屉：选中节点的属性面板（列选择 / 别名 / 聚合 / ...）
- **双向同步**：
  - Canvas → SQL：`builder/sql-emit.ts`（基于 IR）
  - SQL → Canvas：`node-sql-parser` 反向解析；解析失败时禁用反向同步，仅提示「SQL 已超出可视化能力，仅文本编辑」
- 与 §2 SQL 编辑器**共用 Monaco 实例**（同一文档对象，切换 tab 不重建）

---

## 7. F · 数据建模（ER 图）

### 7.1 模型存储

- DB schema：`er_models(id, owner_id, name, dialect, model_json, created_at, updated_at)`
- `model_json` = `{tables:[TableIR], relations:[FK], layout:{positions, sizes}}`

### 7.2 ER Canvas

- 前端 `modeler/er-canvas.tsx`：React Flow + 自定义 `TableNode`（列列表 + PK/FK 图标）+ FK 边（端点连接到具体列）
- 工具栏：Add Table / Auto Layout（dagre 算法）/ Zoom / Export PNG

### 7.3 逆向工程（DB → 模型）

- `internal/dbstudio/er_model.go::ReverseEngineer(node, schemas[])`：
  - 调 adapter 元数据 API → 拼装 `TableIR` + FK 关系
  - layout 用 dagre 自动布局（首次）

### 7.4 正向工程（模型 → DDL）

- `Forward(model) → DDL[]`：复用 §3 designer SQL 生成（同一份 dialect 渲染器）

### 7.5 模型 ↔ DB 同步对比

- `Diff(model, dbSchema) → []SchemaChange`：双向 diff，UI 三栏：
  - **左栏**：仅模型有 → 「Apply to DB」（生成 DDL）
  - **中栏**：差异 → 「Update Model」或「Update DB」
  - **右栏**：仅 DB 有 → 「Pull to Model」

---

## 8. 数据持久化模型（新表汇总）

```sql
-- Saved queries（服务端化）
CREATE TABLE saved_queries (
  id            BIGINT PRIMARY KEY,
  owner_id      BIGINT NOT NULL,
  name          VARCHAR(255) NOT NULL,
  folder_path   VARCHAR(512),
  sql           LONGTEXT NOT NULL,
  params_json   JSON,
  shared_scope  VARCHAR(16) NOT NULL,   -- user|team|node
  updated_at    TIMESTAMP NOT NULL,
  INDEX (owner_id, folder_path)
);

-- Pinned results
CREATE TABLE pinned_results (
  id              BIGINT PRIMARY KEY,
  owner_id        BIGINT NOT NULL,
  node_id         BIGINT NOT NULL,
  sql             LONGTEXT NOT NULL,
  params_json     JSON,
  executed_at     TIMESTAMP NOT NULL,
  rowcount        BIGINT NOT NULL,
  snapshot_arrow  LONGBLOB NOT NULL,    -- Arrow IPC payload
  ttl             TIMESTAMP NOT NULL,
  INDEX (owner_id, node_id, executed_at)
);

-- Query history
CREATE TABLE query_history (
  id            BIGINT PRIMARY KEY,
  owner_id      BIGINT NOT NULL,
  node_id       BIGINT NOT NULL,
  sql           LONGTEXT NOT NULL,
  params_json   JSON,
  executed_at   TIMESTAMP NOT NULL,
  duration_ms   INT NOT NULL,
  rowcount      BIGINT,
  status        VARCHAR(16) NOT NULL,   -- ok|error
  error_text    TEXT,
  INDEX (owner_id, executed_at)
);

-- View profiles
CREATE TABLE view_profiles (
  id            BIGINT PRIMARY KEY,
  owner_id      BIGINT NOT NULL,
  node_id       BIGINT NOT NULL,
  table_fqn     VARCHAR(512) NOT NULL,
  name          VARCHAR(255) NOT NULL,
  filter_json   JSON,
  sort_json     JSON,
  columns_json  JSON,
  is_default    BOOLEAN NOT NULL DEFAULT FALSE,
  updated_at    TIMESTAMP NOT NULL,
  INDEX (owner_id, node_id, table_fqn)
);

-- ER models
CREATE TABLE er_models (
  id            BIGINT PRIMARY KEY,
  owner_id      BIGINT NOT NULL,
  name          VARCHAR(255) NOT NULL,
  dialect       VARCHAR(32) NOT NULL,
  model_json    LONGTEXT NOT NULL,
  created_at    TIMESTAMP NOT NULL,
  updated_at    TIMESTAMP NOT NULL,
  INDEX (owner_id)
);

-- Connection metadata（也可直接给 nodes 表加列）
ALTER TABLE nodes ADD COLUMN db_color VARCHAR(16);
ALTER TABLE nodes ADD COLUMN db_group_path VARCHAR(512);
ALTER TABLE nodes ADD COLUMN db_virtual_groups JSON;
```

GORM migrations 走既有 `pkg/db` 迁移流水（`AutoMigrate`）。

---

## 9. API 表面新增

```
/nodes/:id/db/
  completion/{schemas,tables,columns,functions,keywords}
  plan?sql=...                                  # 可视化执行计划
  profile/{stats,distribution,topn,patterns}
  fk-targets?table=&col=
  saved-queries        (GET LIST / POST / PUT / DELETE)
  pinned-results       (GET LIST / POST / DELETE)
  history              (GET LIST / DELETE)
  view-profiles        (CRUD)
  designer/{table,view,func,proc,trigger,event,index,sequence}
                       (GET / PUT / POST diff / POST apply)

/nodes/:id/mongo/
  databases, collections, documents,
  findOne, insertOne, updateOne, deleteOne, aggregate,
  indexes, createIndex, serverStatus

/nodes/:id/redis/
  dbs, keys, get, set, del, type, ttl, expire,
  info, clientList, slowlog

/dbstudio/
  connections/parse-uri                          (POST)
  er-models                                      (CRUD)
  er-models/:id/reverse                          (POST)
  er-models/:id/forward                          (POST)
  er-models/:id/diff?node_id=                    (POST)
```

---

## 10. 错误处理 & 安全门

- 既有 SQL 安全门保持：`exec` 端点黑/白名单 op、DDL 写入审计
- **新增对象设计器 apply** 走同安全门 + 显式 `Confirmation Required` flag
- **NoSQL 路径单独安全门**：
  - Mongo `aggregate $out / $merge` 默认禁用
  - Redis `FLUSHDB / FLUSHALL / CONFIG / DEBUG` 默认禁用
  - 配置可开启（per-node policy）
- Pinned Results 大小硬上限 10MB / 50k 行，超限截断 + 标记
- 跨子项目错误模型：

```go
type DBError struct {
    Code     string   // INTERNAL | INVALID_SQL | PERMISSION | CAPABILITY | ...
    Message  string
    Hint     string
    Dialect  string
    SQLState string
}
```

沿用既有 handler 风格。

---

## 11. 测试策略

### 11.1 后端

- 适配器契约测试（已就位）扩展到 5 个新接口族（`Designer / Planner / Profiler / Completion / Modeler`）
- `dbstudio/` 业务逻辑用 sqlmock + golden file（DDL diff、ER reverse/forward 输出）
- NoSQL：`mongomock` + `miniredis`（in-memory，不引入容器）

### 11.2 前端

- 各 designer 表单 → DDL 渲染快照测试
- Visual builder ↔ SQL 双向同步 round-trip 测试
- ER canvas 用 React Testing Library + react-flow test helpers

### 11.3 E2E

- Playwright 跑核心路径，每子项目 ≥2 个用例：
  - SQL 编辑器：补全 + 执行计划
  - 设计器：建表 + apply
  - 查看器：外键 picker + Data Profiling
  - 连接：URI 快连 + MongoDB browse
  - 构建器：SQL ↔ Canvas 同步
  - 建模：reverse + diff + apply

---

## 12. 实施路线图

伞 spec 落地后，每个子项目走自己的 plan。建议顺序与并行度：

```
Phase 1  基础设施           §1 Adapter 契约扩展 + dbstudio/ 骨架 + shared/ 前端
Phase 2  并行             A · SQL 编辑器升级
                          C · 数据查看器增强（不依赖 §1）
Phase 3  并行             B · 对象设计器
                          D · 连接 & 数据源（含 Mongo/Redis）
Phase 4                   E · 可视化查询构建器（依赖 A 的 schema cache）
Phase 5                   F · 数据建模（依赖 B 的 designer SQL 渲染）
```

### 12.1 子项目交付门

每个子项目 plan 包含：

1. 后端实现 + 单元测试通过
2. 前端实现 + 组件测试通过
3. ≥2 个 E2E 用例覆盖核心路径
4. capabilities flag 在所有适配器上正确返回
5. 错误模型 / 安全门 / 审计写入对齐既有约定
6. 文档更新（README + API 参考）

---

## 13. 决策记录（ADR 摘要）

| ID | 决策 | 备选 | 选择理由 |
|---|---|---|---|
| ADR-1 | 适配器深化（方案 1） | 抽象 IR 层 / 外挂 DBeaver | 与 Phase 2 迁移同向，不返工；NoSQL 隔离不污染 SQL 路径 |
| ADR-2 | 范围 (b)：核心 80% | 1:1 全功能 / 现有路径增量 | (a) MySQL 调试断点等卡外部依赖；(c) 丢 NoSQL + ER 不满足"全做"语义 |
| ADR-3 | NoSQL 协议双轨（不抽象统一接口） | 抽象统一 Query 接口 | 关系型 / 文档 / KV 语义差异过大，假统一抽象 leak 严重 |
| ADR-4 | 可视化建模选 React Flow | GoJS（商业） / 自研 Canvas | 开源、社区成熟、性能足够、已成事实标准 |
| ADR-5 | Pinned Results 用 Arrow IPC | JSON / CSV / 自定义 | 行列存储紧凑、零拷贝读取、跨语言互通 |
| ADR-6 | 不做 SQL 调试器断点 | 部分 dialect 做 | MySQL 无 dbms_debug；PG/Oracle 各自方言；ROI 极低 |
| ADR-7 | E 与 A 共用 Monaco 实例 | 独立 Monaco | 切 tab 不重建文档，光标 / 撤销栈 / 装饰器保持 |

---

## 14. 非目标（Non-Goals）

- SQL 调试器断点 / 单步 / 监视
- AI 助手 / 自然语言转 SQL
- Snowflake / Redshift / 各家云厂商专用链接器
- HTTP 隧道
- 逻辑模型 / 概念模型 / Data Vault 2.0 / 维度建模
- ODBC 导入
- 用户 / 角色 / 权限 / 表空间可视化设计器（仍走 SQL）
