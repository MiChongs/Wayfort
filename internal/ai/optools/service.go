package optools

import (
	"context"
	"encoding/json"
	"fmt"

	"github.com/michongs/jumpserver-anonymous/internal/ai/tools"
	"github.com/michongs/jumpserver-anonymous/internal/auth"
	"github.com/michongs/jumpserver-anonymous/internal/systemd"
)

func registerServiceTools(reg *tools.Registry, deps Deps) {
	if deps.Systemd == nil {
		return
	}

	nodeReadTool(reg, "systemd_status",
		"获取节点 systemd 总体状态（运行/降级、单元统计、启动耗时）。",
		objSchema(nodeIDProp, "node_id"),
		func(ctx context.Context, t tools.ToolCtx, raw json.RawMessage, nid uint64) (string, error) {
			s, err := deps.Systemd.Status(ctx, t.UserID, nid)
			if err != nil {
				return "", err
			}
			return view("systemd_status", s)
		})

	nodeReadTool(reg, "systemd_list_units",
		"列出 systemd 单元，可按状态过滤（running/failed/enabled/all）。返回单元名、load/active/sub、描述。",
		objSchema(nodeIDProp+`,"filter":{"type":"string","enum":["running","failed","enabled","all"],"description":"过滤器，默认 running"}`, "node_id"),
		func(ctx context.Context, t tools.ToolCtx, raw json.RawMessage, nid uint64) (string, error) {
			var a struct {
				Filter string `json:"filter"`
			}
			_ = json.Unmarshal(raw, &a)
			if a.Filter == "" {
				a.Filter = "running"
			}
			units, err := deps.Systemd.ListUnits(ctx, t.UserID, nid, a.Filter)
			if err != nil {
				return "", err
			}
			return view("systemd_units", units)
		})

	nodeReadTool(reg, "systemd_detail",
		"查看单个 systemd 单元的详情与最近日志。",
		objSchema(nodeIDProp+`,"unit":{"type":"string","description":"单元名，如 nginx.service"},"journal_lines":{"type":"integer","minimum":0,"maximum":500,"description":"附带的日志行数，默认 50"}`, "node_id", "unit"),
		func(ctx context.Context, t tools.ToolCtx, raw json.RawMessage, nid uint64) (string, error) {
			var a struct {
				Unit         string `json:"unit"`
				JournalLines int    `json:"journal_lines"`
			}
			if err := json.Unmarshal(raw, &a); err != nil || a.Unit == "" {
				return "", fmt.Errorf("unit required")
			}
			if a.JournalLines == 0 {
				a.JournalLines = 50
			}
			d, err := deps.Systemd.Detail(ctx, t.UserID, nid, a.Unit, a.JournalLines)
			if err != nil {
				return "", err
			}
			return view("systemd_detail", d)
		})

	nodeReadTool(reg, "systemd_journal",
		"读取某个 systemd 单元的最近 journal 日志。",
		objSchema(nodeIDProp+`,"unit":{"type":"string"},"lines":{"type":"integer","minimum":1,"maximum":1000,"description":"行数，默认 100"}`, "node_id", "unit"),
		func(ctx context.Context, t tools.ToolCtx, raw json.RawMessage, nid uint64) (string, error) {
			var a struct {
				Unit  string `json:"unit"`
				Lines int    `json:"lines"`
			}
			if err := json.Unmarshal(raw, &a); err != nil || a.Unit == "" {
				return "", fmt.Errorf("unit required")
			}
			if a.Lines == 0 {
				a.Lines = 100
			}
			j, err := deps.Systemd.JournalTail(ctx, t.UserID, nid, a.Unit, a.Lines)
			if err != nil {
				return "", err
			}
			return view("log", j)
		})

	// start / stop / restart are separate tools with a fixed verb so the model
	// can never pass an arbitrary control action.
	serviceAction(reg, deps, "systemd_start", "启动", systemd.VerbStart)
	serviceAction(reg, deps, "systemd_stop", "停止", systemd.VerbStop)
	serviceAction(reg, deps, "systemd_restart", "重启", systemd.VerbRestart)
	serviceAction(reg, deps, "systemd_reload", "重载", systemd.VerbReload)
}

func serviceAction(reg *tools.Registry, deps Deps, name, label string, verb systemd.Verb) {
	nodeWriteTool(reg, name,
		fmt.Sprintf("%s指定的 systemd 单元。高危操作，需审批。", label),
		auth.PermServiceManage, label+"服务单元",
		objSchema(nodeIDProp+`,"unit":{"type":"string","description":"单元名，如 nginx.service"}`, "node_id", "unit"),
		func(ctx context.Context, t tools.ToolCtx, raw json.RawMessage, nid uint64) (string, error) {
			var a struct {
				Unit string `json:"unit"`
			}
			if err := json.Unmarshal(raw, &a); err != nil || a.Unit == "" {
				return "", fmt.Errorf("unit required")
			}
			if err := deps.Systemd.Action(ctx, t.UserID, nid, systemdClaims(t), a.Unit, verb); err != nil {
				return "", err
			}
			return fmt.Sprintf("已在节点 %d %s单元 %s", nid, label, a.Unit), nil
		})
}
