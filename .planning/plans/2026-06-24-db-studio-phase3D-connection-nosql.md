# Db Studio Phase 3D · 连接 & 数据源（含 NoSQL） Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 把 Phase 1.4 `nosql` 包（还不存在）和 Phase 1.5 `nodes` 表新增的 3 列（`DBColor`/`DBGroupPath`/`DBVirtualGroups`）落地：MongoDB 文档数据库 + Redis KV 数据库的完整 CRUD/浏览 + 连接分组/颜色/虚拟组/URI 快连。

**Architecture:** 协议双轨（spec §1.4）— 关系型走 `dbquery.Adapter`，NoSQL 走新的 `nosql.Adapter`。两轨同顶层 `model.NodeProtocol` 区分。前端 DBStudio 根据 `node.Protocol` 路由到关系型 shell（既有）或 NoSQL shell（新）。

**Tech Stack:** Go (`go.mongodb.org/mongo-driver/v2` + `github.com/redis/go-redis/v9`，两者**已在 go.sum 传递依赖**，提升为直接依赖)、TypeScript + React 18 + `@tanstack/react-query`。

## Global Constraints

- **不破坏既有**：Phase 1 关系轨不动；新增 NoSQL 轨独立
- **协议双轨**：`nosql.Adapter` 顶层接口与 `dbquery.Adapter` 同层；不共享 SQL 路径
- **NoSQL 安全门**：Mongo `aggregate $out / $merge` 默认禁；Redis `FLUSHDB / FLUSHALL / CONFIG / DEBUG` 默认禁；可 per-node 配置开启（Phase 3D.9）
- **测试覆盖**：Mongo 用 `mongo-driver/mongo/integration/mongomock` 或 in-memory；Redis 用 `miniredis`（`github.com/alicebob/miniredis/v2`）。**两者均需新加为 test-only dep**
- **commit 风格**：`feat(db-studio):` 中文
- **依赖白名单**：
  - 提升为直接：`go.mongodb.org/mongo-driver/v2`、`github.com/redis/go-redis/v9`（mainline 已传递）
  - 新增 test-only：`github.com/alicebob/miniredis/v2`
  - npm：无新增
- **文件大小**：单文件 ≤ 500 行
- **NoSQL 浏览器 UX**：
  - Mongo：左库/集合树 + 右文档网格（JSON + Tree 双视图）+ 顶部 filter/sort/projection/page bar + Aggregation Pipeline 编辑器（拖拽 stage + JSON）
  - Redis：左 db (0-15) + key 树（按 `:` 分隔虚拟分组）+ 右按 type 路由（string/hash/list/set/zset/stream）

---

## File Structure

### 新建文件

```
internal/dbquery/nosql/adapter.go               # NoSQLAdapter interface (CRUD/agg/index/info)
internal/dbquery/nosql/adapter_test.go          # contract: every nosql adapter passes nil-safe + smoke
internal/dbquery/nosql/mongo/adapter.go         # mongo.Driver-backed impl
internal/dbquery/nosql/mongo/adapter_test.go
internal/dbquery/nosql/mongo/security.go        # $out / $merge blacklist
internal/dbquery/nosql/redis/adapter.go         # go-redis-backed impl
internal/dbquery/nosql/redis/adapter_test.go    # uses miniredis
internal/dbquery/nosql/redis/security.go        # FLUSH*/CONFIG/DEBUG blacklist

internal/dbstudio/connections.go                # already exists (Phase 1.4); enhance ParseURI to cover mongo/redis schemes + GroupOps (CRUD groups/colors)
internal/dbstudio/connections_test.go           # already exists; add tests

internal/api/db_nosql_handler.go                # new file: /nodes/:id/{mongo,redis}/* handlers
internal/api/db_nosql_handler_test.go

web/src/components/db/connection/connection-tree.tsx    # tree view with groups + colors
web/src/components/db/connection/uri-dialog.tsx         # URI quick-connect dialog
web/src/components/db/connection/mongo-browser.tsx      # full mongo shell
web/src/components/db/connection/redis-browser.tsx      # full redis shell
web/src/components/db/connection/mongo-aggregation-editor.tsx
```

### 修改文件

```
go.mod / go.sum                                 # promote mongo-driver + go-redis to direct; add miniredis test dep
internal/dbquery/service.go                     # NoSQLAdapterResolver: protocol → nosql.Adapter
internal/server/routes.go                       # mount /nodes/:id/mongo/* and /nodes/:id/redis/*
internal/model/node.go                          # ensure DBColor/DBGroupPath/DBVirtualGroups columns usable
internal/api/db_handler.go                      # node detail response includes db_color/db_group_path/db_virtual_groups

web/src/components/db/db-studio.tsx             # route to NoSQL shell when protocol is mongo/redis
web/src/lib/api/services.ts                     # + dbService.mongo.* / redis.* / node.updateDBMeta
web/src/lib/api/types.ts                        # + MongoDocument / RedisKey / ConnectionGroup etc.
```

---

## Task D1: nosql.Adapter interface + register mongo/redis protocols

**Files:**
- Create: `internal/dbquery/nosql/adapter.go`
- Create: `internal/dbquery/nosql/adapter_test.go`

**Interfaces:**
- Produces:
  - `nosql.Adapter` interface (Protocol/Family/Info/CRUD/Index/ServerStatus)
  - `nosql.Family` enum: `FamilyMongoDB nosql.Family = "document"` / `FamilyRedis = "kv"`
  - Registry `nosql.Default()` + `nosql.Register(adapter)` (mirrors dbquery.Registry)
  - `model.NodeProtoMongoDB` / `NodeProtoRedis` constants (add to existing model.NodeProtocol enum)

- [ ] **Step 1: 写 nosql.Adapter 失败测试**

`internal/dbquery/nosql/adapter_test.go`:

```go
package nosql

import "testing"

func TestRegistryEmptyByDefault(t *testing.T) {
	r := NewRegistry()
	if len(r.List()) != 0 {
		t.Fatalf("expected empty registry, got %v", r.List())
	}
}

func TestRegistryRegisterAndGet(t *testing.T) {
	r := NewRegistry()
	r.Register(&fakeAdapter{proto: "mongo", family: FamilyMongoDB})
	ad, ok := r.Get("mongo")
	if !ok || ad.Protocol() != "mongo" || ad.Family() != FamilyMongoDB {
		t.Fatalf("get: %+v ok=%v", ad, ok)
	}
}

type fakeAdapter struct {
	proto   string
	family  Family
}

func (f *fakeAdapter) Protocol() string           { return f.proto }
func (f *fakeAdapter) Family() Family             { return f.family }
func (f *fakeAdapter) Info(ctx Ctx) (Info, error) { return Info{}, nil }
// ... other methods stubbed returning zero values

type Ctx = interface{ Done() <-chan struct{} }
```

> Note: use real `context.Context` not a custom alias. This sketch is illustrative.

- [ ] **Step 2: 实现 adapter.go**

`internal/dbquery/nosql/adapter.go`:

```go
// Package nosql defines the contract for non-relational database adapters
// in Db Studio. Sibling to internal/dbquery for SQL engines. Two families:
// document (MongoDB) and kv (Redis). Each engine is owned by a leaf subpkg.
package nosql

import (
	"context"
	"sort"
	"sync"
)

// Family is the coarse compatibility band: document store vs KV store.
// Front-end routes to a different shell per family.
type Family string

const (
	FamilyMongoDB Family = "document"
	FamilyRedis   Family = "kv"
)

// Info reports server-side metadata for the connection panel.
type Info struct {
	Version       string `json:"version"`
	Uptime        int64  `json:"uptime_seconds"`
	StorageEngine string `json:"storage_engine"`
	ServerStatus  any    `json:"server_status"` // engine-specific extras
}

// Adapter is the per-engine NoSQL plugin contract. Two implementations ship
// in Phase 3D: mongo.Adapter and redis.Adapter.
type Adapter interface {
	Protocol() string
	Family() Family
	Info(ctx context.Context) (Info, error)
}

// Registry mirrors dbquery.Registry — engine plugins register from init().
type Registry struct {
	mu       sync.RWMutex
	adapters map[string]Adapter
}

func NewRegistry(adapters ...Adapter) *Registry {
	r := &Registry{adapters: map[string]Adapter{}}
	for _, a := range adapters {
		r.Register(a)
	}
	return r
}

var global = &Registry{adapters: map[string]Adapter{}}

func Default() *Registry                 { return global }
func (r *Registry) Register(a Adapter)   { r.mu.Lock(); r.adapters[a.Protocol()] = a; r.mu.Unlock() }
func (r *Registry) Get(p string) (Adapter, bool) {
	r.mu.RLock(); defer r.mu.RUnlock()
	a, ok := r.adapters[p]
	return a, ok
}
func (r *Registry) List() []string {
	r.mu.RLock(); defer r.mu.RUnlock()
	out := make([]string, 0, len(r.adapters))
	for k := range r.adapters {
		out = append(out, k)
	}
	sort.Strings(out)
	return out
}
```

- [ ] **Step 3: 加 NodeProtocol 常量**

In `internal/model/node.go` (or wherever NodeProtocol constants live):

```go
const (
	NodeProtoMongoDB NodeProtocol = "mongodb"
	NodeProtoRedis   NodeProtocol = "redis"
	// ... existing constants
)
```

- [ ] **Step 4: 测试 + 提交**

```bash
go test ./internal/dbquery/nosql -v
git add internal/dbquery/nosql/ internal/model/node.go
git commit -m "feat(db-studio): Phase 3D.1 — nosql.Adapter 接口 + Registry + NodeProtoMongoDB/Redis 常量"
```

---

## Task D2: MongoDB adapter

**Files:**
- Create: `internal/dbquery/nosql/mongo/adapter.go`
- Create: `internal/dbquery/nosql/mongo/security.go`
- Create: `internal/dbquery/nosql/mongo/adapter_test.go`
- Modify: `go.mod` / `go.sum` (promote `go.mongodb.org/mongo-driver/v2` to direct dep)

**Interfaces:**
- Produces:
  - `mongo.New(client *mongo.Client) nosql.Adapter` — full CRUD/aggregation/index/serverStatus
  - Security: `IsForbiddenPipeline(stages []bson.D) bool` — rejects `$out` / `$merge` by default

- [ ] **Step 1: promote mongo-driver to direct dep**

```bash
go get go.mongodb.org/mongo-driver/v2
go mod tidy
```

Verify `go.mod` shows it in the direct require block (not `// indirect`).

- [ ] **Step 2: 写 adapter 测试**

`internal/dbquery/nosql/mongo/adapter_test.go`:

```go
package mongo

import (
	"context"
	"testing"
)

func TestAdapterProtocol(t *testing.T) {
	a := New(nil)
	if a.Protocol() != "mongodb" {
		t.Fatalf("protocol: %s", a.Protocol())
	}
}

func TestIsForbiddenPipeline(t *testing.T) {
	// Default policy: $out and $merge are forbidden.
	cases := []struct {
		name   string
		stages []map[string]any
		want   bool
	}{
		{"plain match", []map[string]any{{"$match": map[string]any{"x": 1}}}, false},
		{"$out", []map[string]any{{"$match": map[string]any{"x": 1}}, {"$out": "leak"}}, true},
		{"$merge", []map[string]any{{"$merge": map[string]any{"into": "leak"}}}, true},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			if got := IsForbiddenPipeline(c.stages); got != c.want {
				t.Fatalf("got %v want %v", got, c.want)
			}
		})
	}
}
```

- [ ] **Step 3: 实现 security.go**

```go
package mongo

// IsForbiddenPipeline reports whether the pipeline contains a stage that
// the default security policy rejects (writes data outside the source
// collection). Per-node policy override is a Phase 3D.9 follow-up.
func IsForbiddenPipeline(stages []map[string]any) bool {
	for _, stage := range stages {
		for key := range stage {
			switch key {
			case "$out", "$merge":
				return true
			}
		}
	}
	return false
}
```

- [ ] **Step 4: 实现 adapter.go (CRUD + Aggregation + Indexes)**

`internal/dbquery/nosql/mongo/adapter.go`:

```go
package mongo

import (
	"context"
	"errors"

	"go.mongodb.org/mongo-driver/v2/bson"
	"go.mongodb.org/mongo-driver/v2/mongo"
)

type Adapter struct {
	client *mongo.Client
}

func New(client *mongo.Client) *Adapter { return &Adapter{client: client} }

func (a *Adapter) Protocol() string { return "mongodb" }
func (a *Adapter) Family() nosql.Family   { return nosql.FamilyMongoDB }

func (a *Adapter) Info(ctx context.Context) (nosql.Info, error) {
	if a == nil || a.client == nil {
		return nosql.Info{}, errors.New("mongo: nil client")
	}
	res := a.client.RunCommand(ctx, bson.D{{Key: "buildInfo", Value: 1}}).Decode
	// ... etc
	return nosql.Info{ /* populated */ }, nil
}

// Databases lists non-system databases.
func (a *Adapter) Databases(ctx context.Context) ([]string, error) { ... }

// Collections lists collections in a database.
func (a *Adapter) Collections(ctx context.Context, db string) ([]string, error) { ... }

// Documents queries a collection with filter / sort / projection / pagination.
func (a *Adapter) Documents(ctx context.Context, db, coll string, filter map[string]any, sort map[string]any, projection map[string]any, limit, skip int64) ([]map[string]any, int64, error) { ... }

// InsertOne / UpdateOne / DeleteOne — direct CRUD passthroughs.
func (a *Adapter) InsertOne(ctx context.Context, db, coll string, doc map[string]any) (any, error) { ... }
func (a *Adapter) UpdateOne(ctx context.Context, db, coll string, filter, update map[string]any) (int64, error) { ... }
func (a *Adapter) DeleteOne(ctx context.Context, db, coll string, filter map[string]any) (int64, error) { ... }

// Aggregate runs a pipeline; rejected by IsForbiddenPipeline.
func (a *Adapter) Aggregate(ctx context.Context, db, coll string, pipeline []map[string]any) ([]map[string]any, error) {
	if IsForbiddenPipeline(pipeline) {
		return nil, errors.New("mongo: pipeline contains a forbidden stage ($out / $merge)")
	}
	// ... etc
}

// Indexes lists indexes; CreateIndex adds one.
func (a *Adapter) Indexes(ctx context.Context, db, coll string) ([]map[string]any, error) { ... }
func (a *Adapter) CreateIndex(ctx context.Context, db, coll string, spec map[string]any) error { ... }
```

> Implementation note: this is a sketch. The actual impl must read the mongo-driver v2 API reference carefully and use proper context + error handling. The v2 API differs from v1 in some signatures.

- [ ] **Step 5: 测试 + 提交**

```bash
go test ./internal/dbquery/nosql/mongo -v
git add internal/dbquery/nosql/mongo/ go.mod go.sum
git commit -m "feat(db-studio): Phase 3D.2 — MongoDB NoSQL adapter（CRUD/agg/index/info）+ 安全门（$out/$merge 禁用）"
```

---

## Task D3: Redis adapter (using miniredis for tests)

**Files:**
- Create: `internal/dbquery/nosql/redis/adapter.go`
- Create: `internal/dbquery/nosql/redis/security.go`
- Create: `internal/dbquery/nosql/redis/adapter_test.go`
- Modify: `go.mod` (add `github.com/alicebob/miniredis/v2` test dep + promote `github.com/redis/go-redis/v9`)

**Interfaces:**
- Produces:
  - `redis.New(client *redis.Client) nosql.Adapter`
  - `redis.IsForbiddenCommand(cmd string) bool` — rejects FLUSHDB/FLUSHALL/CONFIG/DEBUG/SHUTDOWN by default
  - All ops type-aware: STRING / HASH / LIST / SET / ZSET / STREAM

- [ ] **Step 1: add deps**

```bash
go get -t github.com/alicebob/miniredis/v2
go get github.com/redis/go-redis/v9
go mod tidy
```

- [ ] **Step 2: 测试用 miniredis**

`internal/dbquery/nosql/redis/adapter_test.go`:

```go
package redis

import (
	"context"
	"testing"

	"github.com/alicebob/miniredis/v2"
	"github.com/redis/go-redis/v9"
)

func setup(t *testing.T) (*Adapter, *miniredis.Miniredis) {
	t.Helper()
	mr := miniredis.RunT(t)
	client := redis.NewClient(&redis.Options{Addr: mr.Addr()})
	return New(client), mr
}

func TestAdapterSetGet(t *testing.T) {
	a, _ := setup(t)
	ctx := context.Background()
	if err := a.Set(ctx, 0, "greeting", "hello", "string", 0); err != nil {
		t.Fatal(err)
	}
	val, typ, ttl, err := a.Get(ctx, 0, "greeting")
	if err != nil || val != "hello" || typ != "string" {
		t.Fatalf("get: val=%v typ=%s err=%v", val, typ, err)
	}
	_ = ttl
}

func TestAdapterHashOps(t *testing.T) {
	a, _ := setup(t)
	ctx := context.Background()
	if err := a.HashSet(ctx, 0, "user:1", map[string]any{"name": "Alice", "age": 30}); err != nil {
		t.Fatal(err)
	}
	got, err := a.HashGetAll(ctx, 0, "user:1")
	if err != nil || got["name"] != "Alice" {
		t.Fatalf("hgetall: %+v err=%v", got, err)
	}
}

func TestIsForbiddenCommand(t *testing.T) {
	for _, cmd := range []string{"FLUSHDB", "FLUSHALL", "CONFIG", "DEBUG", "SHUTDOWN"} {
		if !IsForbiddenCommand(cmd) {
			t.Fatalf("expected %s forbidden", cmd)
		}
	}
	if IsForbiddenCommand("GET") {
		t.Fatal("GET should be allowed")
	}
}
```

- [ ] **Step 3: 实现 security.go**

```go
package redis

import "strings"

// IsForbiddenCommand reports whether cmd is on the default blacklist.
// Per-node policy override is a Phase 3D.9 follow-up.
func IsForbiddenCommand(cmd string) bool {
	switch strings.ToUpper(cmd) {
	case "FLUSHDB", "FLUSHALL", "CONFIG", "DEBUG", "SHUTDOWN", "BGREWRITEAOF", "BGSAVE":
		return true
	}
	return false
}
```

- [ ] **Step 4: 实现 adapter.go (type-aware KV ops)**

`internal/dbquery/nosql/redis/adapter.go`:

```go
package redis

import (
	"context"
	"errors"
	"time"

	"github.com/redis/go-redis/v9"
)

type Adapter struct {
	client *redis.Client
}

func New(client *redis.Client) *Adapter { return &Adapter{client: client} }

func (a *Adapter) Protocol() string         { return "redis" }
func (a *Adapter) Family() nosql.Family     { return nosql.FamilyRedis }

func (a *Adapter) Info(ctx context.Context) (nosql.Info, error) {
	if a == nil || a.client == nil {
		return nosql.Info{}, errors.New("redis: nil client")
	}
	raw, err := a.client.Info(ctx).Result()
	if err != nil {
		return nosql.Info{}, err
	}
	// Parse INFO output; populate Info struct.
	return nosql.Info{Version: parseInfoField(raw, "redis_version"), ServerStatus: raw}, nil
}

// DBs returns the 16 logical databases (0-15) with key counts.
func (a *Adapter) DBs(ctx context.Context) ([]DBInfo, error) { ... }

// Keys uses SCAN (never KEYS) to enumerate keys matching a pattern.
// Returns a page of keys + next cursor.
func (a *Adapter) Keys(ctx context.Context, db int, pattern string, cursor uint64, count int64) ([]string, uint64, error) { ... }

// Get returns value/type/ttl for a key.
func (a *Adapter) Get(ctx context.Context, db int, key string) (val string, typ string, ttl int64, err error) { ... }

// Set writes a key. typ ∈ {string, hash, list, set, zset, stream}.
func (a *Adapter) Set(ctx context.Context, db int, key string, val any, typ string, ttlSec int) error { ... }

// Del removes a key.
func (a *Adapter) Del(ctx context.Context, db int, key string) error { ... }

// HashSet / HashGet / HashGetAll, ListPush / ListRange, SetAdd / SetMembers,
// ZSetAdd / ZSetRange, StreamAdd / StreamRange — type-specific ops.
func (a *Adapter) HashSet(ctx context.Context, db int, key string, fields map[string]any) error { ... }
func (a *Adapter) HashGetAll(ctx context.Context, db int, key string) (map[string]string, error) { ... }
// ... etc

// RunCommand executes a single arbitrary Redis command, gated by IsForbiddenCommand.
func (a *Adapter) RunCommand(ctx context.Context, db int, cmd string, args ...any) (any, error) {
	if IsForbiddenCommand(cmd) {
		return nil, fmt.Errorf("redis: command %s forbidden by default policy", cmd)
	}
	// ... etc
}
```

> Implementation note: db param is the logical db index (0-15); switch with `a.client.WithDB(db)` or equivalent.

- [ ] **Step 5: 测试 + 提交**

```bash
go test ./internal/dbquery/nosql/redis -v
git add internal/dbquery/nosql/redis/ go.mod go.sum
git commit -m "feat(db-studio): Phase 3D.3 — Redis NoSQL adapter（type-aware ops + SCAN + 安全门）+ miniredis test dep"
```

---

## Task D4: HTTP handlers for /nodes/:id/mongo/* and /nodes/:id/redis/*

**Files:**
- Create: `internal/api/db_nosql_handler.go`
- Create: `internal/api/db_nosql_handler_test.go`
- Modify: `internal/dbquery/service.go` (+ `NoSQLAdapter(nodeID) (nosql.Adapter, error)` helper)
- Modify: `internal/server/routes.go`

**Interfaces:**
- Produces:
  - `api.DBNoSQLHandler` with two route groups: `/mongo/*` and `/redis/*`
  - Routes:
    - Mongo: `databases`, `collections`, `documents`, `findOne`, `insertOne`, `updateOne`, `deleteOne`, `aggregate`, `indexes`, `createIndex`, `serverStatus`
    - Redis: `dbs`, `keys`, `get`, `set`, `del`, `type`, `ttl`, `expire`, `info`, `clientList`, `slowlog`

- [ ] **Step 1: 服务 helper**

`internal/dbquery/service.go`:

```go
// NoSQLAdapter resolves the NoSQL adapter for a node. Returns nil + nil error
// when the node protocol isn't NoSQL (caller decides how to handle).
func (s *Service) NoSQLAdapter(nodeID uint64) (nosql.Adapter, error) {
	n, err := s.nodes.Get(nodeID)
	if err != nil { return nil, err }
	ad, ok := nosql.Default().Get(string(n.Protocol))
	if !ok { return nil, nil }
	// Adapter holds the *mongo.Client / *redis.Client; resolve per-node from
	// connection pool (similar to SQL adapter pool). Defer to existing helper.
	return ad, nil
}
```

> Implementation note: the actual impl needs to construct (or fetch from pool) the per-node mongo/redis client from the node's connection spec. This is more involved than SQL — mongo/redis clients aren't typically pooled the same way. Likely a `sync.Map[uint64]nosql.Adapter` cache with TTL eviction.

- [ ] **Step 2: DBNoSQLHandler 实现**

`internal/api/db_nosql_handler.go`:

```go
package api

import (
	"net/http"
	"strings"

	"github.com/gin-gonic/gin"
)

// DBNoSQLHandler exposes /api/v1/nodes/:id/{mongo,redis}/* endpoints.
// Nil-safe: 503 when Svc is nil or node protocol doesn't match the path.
type DBNoSQLHandler struct {
	Svc *dbquery.Service
}

func NewDBNoSQLHandler(svc *dbquery.Service) *DBNoSQLHandler {
	return &DBNoSQLHandler{Svc: svc}
}

// Mongo Databases — GET /api/v1/nodes/:id/mongo/databases
func (h *DBNoSQLHandler) MongoDatabases(c *gin.Context) {
	ad, ok := h.gateMongo(c)
	if !ok { return }
	dbs, err := ad.Databases(c.Request.Context())
	if err != nil { c.JSON(http.StatusBadGateway, gin.H{"error": err.Error()}); return }
	c.JSON(http.StatusOK, gin.H{"databases": dbs})
}

// ... 9 more Mongo handlers (Collections, Documents, FindOne, InsertOne, UpdateOne, DeleteOne, Aggregate, Indexes, CreateIndex, ServerStatus)

// Redis DBs — GET /api/v1/nodes/:id/redis/dbs
func (h *DBNoSQLHandler) RedisDBs(c *gin.Context) {
	ad, ok := h.gateRedis(c)
	if !ok { return }
	dbs, err := ad.DBs(c.Request.Context())
	if err != nil { c.JSON(http.StatusBadGateway, gin.H{"error": err.Error()}); return }
	c.JSON(http.StatusOK, gin.H{"dbs": dbs})
}

// ... 9 more Redis handlers (Keys, Get, Set, Del, Type, TTL, Expire, Info, ClientList, SlowLog)

func (h *DBNoSQLHandler) gateMongo(c *gin.Context) (nosql.Adapter, bool) {
	if h == nil || h.Svc == nil {
		c.JSON(http.StatusServiceUnavailable, gin.H{"error": "nosql disabled"})
		return nil, false
	}
	nodeID, _, ok := h.gateNode(c)
	if !ok { return nil, false }
	ad, err := h.Svc.NoSQLAdapter(nodeID)
	if err != nil || ad == nil || ad.Family() != nosql.FamilyMongoDB {
		c.JSON(http.StatusBadGateway, gin.H{"error": "node is not a MongoDB connection"})
		return nil, false
	}
	return ad, true
}

// gateRedis mirrors gateMongo for redis.FamilyRedis.

func (h *DBNoSQLHandler) gateNode(c *gin.Context) (uint64, *auth.Claims, bool) {
	// Reuse existing DBHandler.gate pattern; if DBNoSQLHandler doesn't have access,
	// extract to shared util.
}
```

- [ ] **Step 3: routes.go mount**

```go
if rt.DBNoSQL != nil {
	mg := ops.Group("/nodes/:id/mongo")
	mg.GET("/databases", rt.DBNoSQL.MongoDatabases)
	mg.GET("/collections", rt.DBNoSQL.MongoCollections)
	mg.GET("/documents", rt.DBNoSQL.MongoDocuments)
	mg.POST("/findOne", rt.DBNoSQL.MongoFindOne)
	mg.POST("/insertOne", rt.DBNoSQL.MongoInsertOne)
	mg.POST("/updateOne", rt.DBNoSQL.MongoUpdateOne)
	mg.POST("/deleteOne", rt.DBNoSQL.MongoDeleteOne)
	mg.POST("/aggregate", rt.DBNoSQL.MongoAggregate)
	mg.GET("/indexes", rt.DBNoSQL.MongoIndexes)
	mg.POST("/indexes", rt.DBNoSQL.MongoCreateIndex)
	mg.GET("/serverStatus", rt.DBNoSQL.MongoServerStatus)

	rd := ops.Group("/nodes/:id/redis")
	rd.GET("/dbs", rt.DBNoSQL.RedisDBs)
	rd.GET("/keys", rt.DBNoSQL.RedisKeys)
	rd.GET("/get", rt.DBNoSQL.RedisGet)
	rd.POST("/set", rt.DBNoSQL.RedisSet)
	rd.POST("/del", rt.DBNoSQL.RedisDel)
	rd.GET("/type", rt.DBNoSQL.RedisType)
	rd.GET("/ttl", rt.DBNoSQL.RedisTTL)
	rd.POST("/expire", rt.DBNoSQL.RedisExpire)
	rd.GET("/info", rt.DBNoSQL.RedisInfo)
	rd.GET("/clientList", rt.DBNoSQL.RedisClientList)
	rd.GET("/slowlog", rt.DBNoSQL.RedisSlowlog)
}
```

Add `DBNoSQL *api.DBNoSQLHandler` to `Routes` struct + wire in main.go.

- [ ] **Step 4: 测试 + 提交**

```bash
go test ./internal/api -v -run TestDBNoSQL
git add internal/dbquery/service.go internal/api/db_nosql_handler.go internal/api/db_nosql_handler_test.go internal/server/routes.go cmd/wayfort/main.go
git commit -m "feat(db-studio): Phase 3D.4 — /nodes/:id/{mongo,redis}/* HTTP 端点（10+10）+ DBNoSQLHandler + service helper"
```

---

## Task D5: Frontend Connection tree + URI quick-connect dialog

**Files:**
- Create: `web/src/components/db/connection/connection-tree.tsx`
- Create: `web/src/components/db/connection/uri-dialog.tsx`
- Modify: `internal/dbstudio/connections.go` (extend `ParseConnectionURI` to accept mongo+redis schemes)
- Modify: `internal/api/db_handler.go` (Node detail response includes `db_color`, `db_group_path`, `db_virtual_groups`)
- Modify: `web/src/lib/api/services.ts` (+ `nodeService.updateDBMeta(nodeId, {color, groupPath, virtualGroups})`)
- Modify: `web/src/lib/api/types.ts` (Node type +3 fields if not present)

**Interfaces:**
- Produces:
  - `<ConnectionTree nodes={...} onSelect={...}/>` — tree with group paths + color dots + drag-drop to re-group
  - `<URIDialog open onClose onConnected={...}/>` — text input + parse + prefilled node-create form

- [ ] **Step 1: backend — ParseConnectionURI supports mongo+redis**

Already in Phase 1.4 the URL parser handles any scheme. Verify `ParseConnectionURI("mongodb://user:pass@host:27017/db?authSource=admin")` works. Add explicit test case if missing.

For Redis URIs (`redis://:password@host:6379/2`), the db index comes from path. Add to ConnectionURI struct if needed: `RedisDB int`.

- [ ] **Step 2: backend — Node detail returns db_color / db_group_path / db_virtual_groups**

Verify the existing `/api/v1/nodes/:id` response serializes the Phase 1.5 GORM fields. If the JSON tags are missing on `Node.DBColor` etc., add them.

- [ ] **Step 3: backend — updateDBMeta endpoint**

`POST /api/v1/nodes/:id/db-meta` body `{color, group_path, virtual_groups}` → updates Node.

Handler in `internal/api/db_handler.go`:

```go
func (h *DBHandler) UpdateDBMeta(c *gin.Context) {
	nodeID, _, ok := h.gate(c)
	if !ok { return }
	var body struct {
		Color         string `json:"color"`
		GroupPath     string `json:"group_path"`
		VirtualGroups []string `json:"virtual_groups"`
	}
	if err := c.ShouldBindJSON(&body); err != nil { c.JSON(http.StatusBadRequest, gin.H{"error": err.Error()}); return }
	if err := h.Svc.UpdateNodeDBMeta(c.Request.Context(), nodeID, body.Color, body.GroupPath, body.VirtualGroups); err != nil {
		c.JSON(http.StatusBadGateway, gin.H{"error": err.Error()}); return
	}
	c.Status(http.StatusNoContent)
}
```

`service.go`:

```go
func (s *Service) UpdateNodeDBMeta(ctx context.Context, nodeID uint64, color, groupPath string, vgroups []string) error {
	vgroupJSON, _ := json.Marshal(vgroups)
	return s.nodes.UpdateColumns(ctx, nodeID, map[string]any{
		"db_color": color, "db_group_path": groupPath, "db_virtual_groups": string(vgroupJSON),
	})
}
```

- [ ] **Step 4: 前端 ConnectionTree**

`web/src/components/db/connection/connection-tree.tsx`: builds a tree from `nodes` flat list using `db_group_path` ("team-a/prod"). Each node shows a colored dot from `db_color`. Drag-drop updates `db_group_path` via `nodeService.updateDBMeta`.

- [ ] **Step 5: 前端 URIDialog**

`web/src/components/db/connection/uri-dialog.tsx`: text input + parse button (calls `dbStudioService.parseUri`); prefilled node-create form on success.

- [ ] **Step 6: typecheck + 测试 + 提交**

```bash
cd web && pnpm typecheck
go test ./internal/dbstudio ./internal/api -v
git add internal/dbstudio/connections.go internal/dbstudio/connections_test.go internal/dbquery/service.go internal/api/db_handler.go internal/server/routes.go web/src/components/db/connection/ web/src/lib/api/services.ts web/src/lib/api/types.ts
git commit -m "feat(db-studio): Phase 3D.5 — 连接分组/颜色/虚拟组 + URI 快连（Mongo/Redis 兼容）+ 前端树形 UI"
```

---

## Task D6: Frontend Mongo browser

**Files:**
- Create: `web/src/components/db/connection/mongo-browser.tsx`
- Create: `web/src/components/db/connection/mongo-aggregation-editor.tsx`
- Modify: `web/src/components/db/db-studio.tsx` (route to NoSQL shell when protocol is mongodb)
- Modify: `web/src/lib/api/services.ts` (+ `dbService.mongo.*` methods)
- Modify: `web/src/lib/api/types.ts` (+ MongoDocument / MongoIndex types)

**Interfaces:**
- Produces:
  - `<MongoBrowser nodeId={...}/>` — full mongo shell:
    - Left: database / collection tree (lazy load)
    - Right: document grid (JSON + Tree dual view), filter bar, sort, projection, pagination
    - Aggregation Pipeline editor (stage cards + JSON)

- [ ] **Step 1: TS types**

```ts
export interface MongoDocument {
  _id: string
  [key: string]: unknown
}
export interface MongoIndex {
  name: string
  keys: Record<string, 1 | -1>
  unique?: boolean
  sparse?: boolean
}
```

- [ ] **Step 2: services.ts**

```ts
mongo: {
  databases: (nodeId: number) => api.get<{ databases: string[] }>(`/nodes/${nodeId}/mongo/databases`),
  collections: (nodeId: number, db: string) => api.get<{ collections: string[] }>(`/nodes/${nodeId}/mongo/collections`, { params: { db } }),
  documents: (nodeId: number, db: string, coll: string, params: { filter?: string; sort?: string; projection?: string; limit?: number; skip?: number }) =>
    api.get<{ documents: MongoDocument[]; total: number }>(`/nodes/${nodeId}/mongo/documents`, { params: { db, coll, ...params } }),
  findOne: (nodeId: number, db: string, coll: string, filter: string) =>
    api.post<{ document: MongoDocument | null }>(`/nodes/${nodeId}/mongo/findOne`, { db, coll, filter }),
  insertOne: (nodeId: number, db: string, coll: string, doc: string) =>
    api.post<{ insertedId: string }>(`/nodes/${nodeId}/mongo/insertOne`, { db, coll, doc }),
  updateOne: (nodeId: number, db: string, coll: string, filter: string, update: string) =>
    api.post<{ matchedCount: number; modifiedCount: number }>(`/nodes/${nodeId}/mongo/updateOne`, { db, coll, filter, update }),
  deleteOne: (nodeId: number, db: string, coll: string, filter: string) =>
    api.post<{ deletedCount: number }>(`/nodes/${nodeId}/mongo/deleteOne`, { db, coll, filter }),
  aggregate: (nodeId: number, db: string, coll: string, pipeline: string) =>
    api.post<{ documents: MongoDocument[] }>(`/nodes/${nodeId}/mongo/aggregate`, { db, coll, pipeline }),
  indexes: (nodeId: number, db: string, coll: string) =>
    api.get<{ indexes: MongoIndex[] }>(`/nodes/${nodeId}/mongo/indexes`, { params: { db, coll } }),
  createIndex: (nodeId: number, db: string, coll: string, spec: string) =>
    api.post<void>(`/nodes/${nodeId}/mongo/indexes`, { db, coll, spec }),
},
```

- [ ] **Step 3: MongoBrowser 组件**

`web/src/components/db/connection/mongo-browser.tsx`:

```tsx
"use client";

import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { dbService } from "@/lib/api/services";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { MongoAggregationEditor } from "./mongo-aggregation-editor";

interface Props { nodeId: number }

export function MongoBrowser({ nodeId }: Props) {
  const [db, setDb] = useState("");
  const [coll, setColl] = useState("");
  const [filter, setFilter] = useState("");
  const [view, setView] = useState<"documents" | "aggregation">("documents");

	const { data: dbs } = useQuery({
    queryKey: ["mongo-dbs", nodeId],
    queryFn: () => dbService.mongo.databases(nodeId),
  });
  const { data: colls } = useQuery({
    queryKey: ["mongo-colls", nodeId, db],
    queryFn: () => dbService.mongo.collections(nodeId, db),
    enabled: !!db,
  });
  const { data: docs } = useQuery({
    queryKey: ["mongo-docs", nodeId, db, coll, filter],
    queryFn: () => dbService.mongo.documents(nodeId, db, coll, { filter, limit: 100 }),
    enabled: !!db && !!coll,
  });

  return (
    <div className="flex h-full">
      {/* Left: db + coll tree */}
      <div className="w-64 border-r overflow-auto p-2">
        <ul className="text-sm">
          {(dbs?.databases ?? []).map((d) => (
            <li key={d}>
              <button onClick={() => setDb(d)} className={d === db ? "font-bold" : ""}>📁 {d}</button>
              {d === db && (
                <ul className="pl-3">
                  {(colls?.collections ?? []).map((c) => (
                    <li key={c}>
                      <button onClick={() => setColl(c)} className={c === coll ? "font-bold" : ""}>📄 {c}</button>
                    </li>
                  ))}
                </ul>
              )}
            </li>
          ))}
        </ul>
      </div>
      {/* Right: doc grid / aggregation */}
      <div className="flex-1 flex flex-col">
        <div className="flex gap-2 p-2 border-b">
          <Input placeholder='{ "x": 1 }' value={filter} onChange={(e) => setFilter(e.target.value)} />
          <Button variant={view === "documents" ? "default" : "ghost"} onClick={() => setView("documents")}>文档</Button>
          <Button variant={view === "aggregation" ? "default" : "ghost"} onClick={() => setView("aggregation")}>聚合</Button>
        </div>
        {view === "documents" ? (
          <pre className="flex-1 overflow-auto p-2 text-xs">{JSON.stringify(docs?.documents ?? [], null, 2)}</pre>
        ) : (
          <MongoAggregationEditor nodeId={nodeId} db={db} coll={coll} />
        )}
      </div>
    </div>
  );
}
```

> Note: this is a sketch. Real implementation uses proper `document-grid.tsx` with column detection, inline-edit, pagination. Approximate scope: ~250-350 lines for the full browser.

- [ ] **Step 4: MongoAggregationEditor**

Stage cards with drag-to-reorder + JSON body editor + live "Run" button.

- [ ] **Step 5: db-studio.tsx routing**

```tsx
const isNoSQL = node?.protocol === "mongodb" || node?.protocol === "redis";
if (isNoSQL) {
  return node?.protocol === "mongodb" ? <MongoBrowser nodeId={nodeId}/> : <RedisBrowser nodeId={nodeId}/>;
}
return /* existing SQL Studio shell */;
```

- [ ] **Step 6: typecheck + 提交**

```bash
cd web && pnpm typecheck
git add web/src/components/db/connection/mongo-browser.tsx web/src/components/db/connection/mongo-aggregation-editor.tsx web/src/components/db/db-studio.tsx web/src/lib/api/services.ts web/src/lib/api/types.ts
git commit -m "feat(db-studio): Phase 3D.6 — 前端 MongoDB 浏览器（db/coll 树 + 文档网格 + 聚合编辑器）"
```

---

## Task D7: Frontend Redis browser

**Files:**
- Create: `web/src/components/db/connection/redis-browser.tsx`
- Modify: `web/src/components/db/db-studio.tsx` (route to RedisBrowser)
- Modify: `web/src/lib/api/services.ts` (+ `dbService.redis.*`)
- Modify: `web/src/lib/api/types.ts` (+ RedisKeyInfo / RedisTypeInfo)

**Interfaces:**
- Produces:
  - `<RedisBrowser nodeId={...}/>` — full redis shell:
    - Left: db selector (0-15) + key tree (virtual groups by `:` separator) + SCAN pagination
    - Right: type-aware editor (string / hash / list / set / zset / stream each its own sub-component)

- [ ] **Step 1-6: 同 D6 模式 (types → services → component → integration)**

Key differences vs Mongo:
- SCAN with cursor instead of pagination offset
- Type-specific editors (6 types)
- TTL display + edit (set/remove)
- Run-command dialog (gated by `IsForbiddenCommand`)

- [ ] **Step 7: typecheck + 提交**

```bash
cd web && pnpm typecheck
git add web/src/components/db/connection/redis-browser.tsx web/src/components/db/db-studio.tsx web/src/lib/api/services.ts web/src/lib/api/types.ts
git commit -m "feat(db-studio): Phase 3D.7 — 前端 Redis 浏览器（db 选择 + key 树 + 6 种类型专属编辑器）"
```

---

## Task D8: Integration smoke + spec marker

**Files:**
- Modify: `.planning/specs/2026-06-23-db-studio-navicat-parity-design.md` (mark Phase 3D done)

- [ ] **Step 1: 端到端 build + test**

```bash
go build ./...
go test ./internal/dbquery/nosql/... ./internal/api -v -run TestDBNoSQL
cd web && pnpm typecheck
```

- [ ] **Step 2: spec 顶部加 Phase 3D banner**

类似 Phase 1 完成标记。

- [ ] **Step 3: 提交**

```bash
git add .planning/specs/2026-06-23-db-studio-navicat-parity-design.md
git commit -m "docs(db-studio): Phase 3D 完成 — MongoDB + Redis NoSQL 轨道 + 连接管理（URI/分组/颜色）"
```

---

## Self-Review

**1. Spec coverage**

| Spec §5 项目 | 对应任务 |
|---|---|
| MongoDB 文档数据库 | D2 (adapter) + D4 (HTTP) + D6 (前端) |
| Redis KV 数据库 | D3 (adapter) + D4 (HTTP) + D7 (前端) |
| URI 快连 | D5 (backend Phase 1.6 已有 parse-uri；D5 扩展 mongo/redis scheme 支持) |
| 连接分组 / 颜色 / 虚拟组 | D5 (CRUD endpoints + 前端 tree) |
| 连接复制 | （跳过：等同"新建节点 + 复制字段"，前端按钮，非本 phase 关键） |

**2. Placeholder scan**

- 没有 "TBD" 字眼
- D2/D3 的 adapter.go impl 给了完整签名和关键路径，implementer 跟着 mongo-driver / go-redis v2 官方 API 写完整实现
- D6/D7 的前端组件给了 sketch + scope 提示（"~250-350 lines"），不算占位

**3. Type consistency**

- `model.NodeProtoMongoDB = "mongodb"` ↔ `nosql.Adapter.Protocol() = "mongodb"` ↔ frontend `node.protocol === "mongodb"` — 全程字符串字面量一致
- Mongo JSON 文档：Go `map[string]any` ↔ TS `MongoDocument = { _id: string, [key: string]: unknown }`
- Redis key types：Go 字符串 `"string"|"hash"|"list"|"set"|"zset"|"stream"` ↔ TS union

**4. Ambiguity check**

- NoSQL 客户端连接池：D4 step 1 显式提示需要 `sync.Map` 缓存 + TTL 驱逐；如果既有项目有类似机制（看 `dbquery.Service` 的 SQL 连接池）则复用
- Aggregation Pipeline 编辑器：D6 给了 stage cards + JSON body 概念；具体 UX（拖拽 vs 上下箭头）由 implementer 定
- Redis SCAN count 默认值：D3 step 4 没指定，建议 implementer 用 200（性能/响应大小平衡）

**5. 安全**

- Mongo `$out` / `$merge` 默认禁（D2 IsForbiddenPipeline）
- Redis `FLUSH*` / `CONFIG` / `DEBUG` / `SHUTDOWN` 默认禁（D3 IsForbiddenCommand）
- per-node 配置 override 留给 Phase 3D.9 / 后续 plan

---

## Execution Handoff

**Plan complete and saved to `.planning/plans/2026-06-24-db-studio-phase3D-connection-nosql.md`. Two execution options:**

**1. Subagent-Driven (recommended)** — 每个 task 派新 subagent，task 间检阅
**2. Inline Execution** — 在本会话直接批执行

**Which approach?** (默认 1)

---

## Notes on Parallel Execution with Phase 3B

This plan is **largely independent** of Phase 3B (`.planning/plans/2026-06-24-db-studio-phase3B-object-designer.md`):
- B 改 `internal/dbquery/designer/`；D 新建 `internal/dbquery/nosql/` — 包级独立
- B 改 `dbstudio/object_apply.go`；D 改 `dbstudio/connections.go` — 文件级独立
- B 改 `internal/api/db_capability_handler.go`；D 新建 `internal/api/db_nosql_handler.go` — 文件级独立
- B 改 `web/src/components/db/designer/`；D 新建 `web/src/components/db/connection/` — 文件级独立

**会冲突的共享文件**：
- `internal/server/routes.go`（两者都挂新路由）
- `internal/dbquery/service.go`（两者都加 helper）
- `web/src/components/db/db-studio.tsx`（两者都改 shell：B 加"设计器"tab；D 加 NoSQL 协议路由）
- `web/src/lib/api/services.ts` + `types.ts`（两者都加 entries）
- `cmd/wayfort/main.go`（两者都可能 wire handler）

冲突解决策略：控制器协调，B/D 各自的"集成 step"（B5/B7/D4/D5/D6/D7）按串行顺序 dispatch；其它独立 task（B1/B2/B3/B4/D1/D2/D3）可并行。
