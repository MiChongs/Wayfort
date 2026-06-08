package optools

import (
	"context"
	"encoding/json"
	"fmt"

	"github.com/michongs/jumpserver-anonymous/internal/ai/tools"
)

// Database tools reuse the same dbquery.Service the REST DB Studio uses, so the
// MySQL / PostgreSQL / Dameng adapters, connection pools and proxy chains are
// shared. Note dbquery's argument order is (nodeID, userID) — the opposite of
// the ops Managers — so the closures pass nid first.
func registerDBTools(reg *tools.Registry, deps Deps) {
	if deps.DBQuery == nil {
		return
	}

	nodeReadTool(reg, "db_databases",
		"列出数据库节点上可见的数据库/schema 名称。",
		objSchema(nodeIDProp, "node_id"),
		func(ctx context.Context, t tools.ToolCtx, raw json.RawMessage, nid uint64) (string, error) {
			dbs, err := deps.DBQuery.ListDatabases(ctx, nid, t.UserID)
			if err != nil {
				return "", err
			}
			return view("db_databases", dbs)
		})

	nodeReadTool(reg, "db_tables",
		"列出某个数据库的表/视图结构概览（schema、表名、行数估计、注释）。",
		objSchema(nodeIDProp+`,"database":{"type":"string","description":"数据库名，可空用默认库"}`, "node_id"),
		func(ctx context.Context, t tools.ToolCtx, raw json.RawMessage, nid uint64) (string, error) {
			db, _ := strOpt(raw, "database")
			info, err := deps.DBQuery.LoadSchema(ctx, nid, t.UserID, db)
			if err != nil {
				return "", err
			}
			return view("db_schema", info)
		})

	nodeReadTool(reg, "db_columns",
		"查看某张表的列定义（名称、类型、可空、主键、默认值）。",
		objSchema(nodeIDProp+`,"database":{"type":"string"},"schema":{"type":"string","description":"schema 名，可空"},"table":{"type":"string"}`, "node_id", "table"),
		func(ctx context.Context, t tools.ToolCtx, raw json.RawMessage, nid uint64) (string, error) {
			var a struct {
				Database string `json:"database"`
				Schema   string `json:"schema"`
				Table    string `json:"table"`
			}
			if err := json.Unmarshal(raw, &a); err != nil || a.Table == "" {
				return "", fmt.Errorf("table required")
			}
			cols, err := deps.DBQuery.LoadColumns(ctx, nid, t.UserID, a.Database, a.Schema, a.Table)
			if err != nil {
				return "", err
			}
			return view("db_columns", cols)
		})

	nodeReadTool(reg, "db_query",
		"执行只读 SQL 查询并返回行列结果集（最多 max_rows 行）。仅用于 SELECT/SHOW 等只读语句；写入请用 db_exec。",
		objSchema(nodeIDProp+`,"database":{"type":"string","description":"数据库名，可空"},"statement":{"type":"string","description":"SQL 查询语句"},"max_rows":{"type":"integer","minimum":1,"maximum":1000,"description":"返回上限，默认服务端配置"}`, "node_id", "statement"),
		func(ctx context.Context, t tools.ToolCtx, raw json.RawMessage, nid uint64) (string, error) {
			var a struct {
				Database  string `json:"database"`
				Statement string `json:"statement"`
				MaxRows   int    `json:"max_rows"`
			}
			if err := json.Unmarshal(raw, &a); err != nil || a.Statement == "" {
				return "", fmt.Errorf("statement required")
			}
			res, err := deps.DBQuery.Query(ctx, nid, t.UserID, a.Database, a.Statement, nil, a.MaxRows)
			if err != nil {
				return "", err
			}
			return view("db_result", res)
		})

	nodeReadTool(reg, "db_explain",
		"获取 SQL 语句的执行计划（EXPLAIN，不实际执行写入）。",
		objSchema(nodeIDProp+`,"database":{"type":"string"},"statement":{"type":"string"}`, "node_id", "statement"),
		func(ctx context.Context, t tools.ToolCtx, raw json.RawMessage, nid uint64) (string, error) {
			var a struct {
				Database  string `json:"database"`
				Statement string `json:"statement"`
			}
			if err := json.Unmarshal(raw, &a); err != nil || a.Statement == "" {
				return "", fmt.Errorf("statement required")
			}
			// analyze=false: never run the statement for real (PG EXPLAIN ANALYZE
			// would execute writes).
			res, err := deps.DBQuery.Explain(ctx, nid, t.UserID, a.Database, a.Statement, false)
			if err != nil {
				return "", err
			}
			return view("db_result", res)
		})

	nodeReadTool(reg, "db_processes",
		"列出数据库当前的会话/进程（用于排查锁、慢查询、连接占用）。",
		objSchema(nodeIDProp+`,"database":{"type":"string"}`, "node_id"),
		func(ctx context.Context, t tools.ToolCtx, raw json.RawMessage, nid uint64) (string, error) {
			db, _ := strOpt(raw, "database")
			ps, err := deps.DBQuery.ListProcesses(ctx, nid, t.UserID, db)
			if err != nil {
				return "", err
			}
			return view("db_processes", ps)
		})

	nodeWriteTool(reg, "db_exec",
		"执行写入型 SQL（INSERT/UPDATE/DELETE/DDL），返回受影响行数。高危操作，需审批。",
		"", "执行写入 SQL",
		objSchema(nodeIDProp+`,"database":{"type":"string"},"statement":{"type":"string","description":"写入/DDL 语句"}`, "node_id", "statement"),
		func(ctx context.Context, t tools.ToolCtx, raw json.RawMessage, nid uint64) (string, error) {
			var a struct {
				Database  string `json:"database"`
				Statement string `json:"statement"`
			}
			if err := json.Unmarshal(raw, &a); err != nil || a.Statement == "" {
				return "", fmt.Errorf("statement required")
			}
			res, err := deps.DBQuery.Exec(ctx, nid, t.UserID, a.Database, a.Statement, nil)
			if err != nil {
				return "", err
			}
			return view("db_exec_result", res)
		})

	nodeWriteTool(reg, "db_kill",
		"终止数据库中的某个会话/进程(pid 来自 db_processes)。高危操作，需审批。",
		"", "终止数据库会话",
		objSchema(nodeIDProp+`,"database":{"type":"string"},"pid":{"type":"integer","description":"数据库进程 ID"}`, "node_id", "pid"),
		func(ctx context.Context, t tools.ToolCtx, raw json.RawMessage, nid uint64) (string, error) {
			var a struct {
				Database string `json:"database"`
				PID      int64  `json:"pid"`
			}
			if err := json.Unmarshal(raw, &a); err != nil || a.PID == 0 {
				return "", fmt.Errorf("pid required")
			}
			ok, err := deps.DBQuery.CancelProcess(ctx, nid, t.UserID, a.Database, a.PID)
			if err != nil {
				return "", err
			}
			return fmt.Sprintf("已请求终止数据库会话 %d（成功=%v）", a.PID, ok), nil
		})
}

// strOpt extracts an optional string field (no error when absent).
func strOpt(raw json.RawMessage, field string) (string, bool) {
	var m map[string]any
	if json.Unmarshal(raw, &m) != nil {
		return "", false
	}
	v, ok := m[field].(string)
	return v, ok
}
