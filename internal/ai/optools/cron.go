package optools

import (
	"context"
	"encoding/json"
	"fmt"

	"github.com/michongs/wayfort/internal/ai/tools"
	"github.com/michongs/wayfort/internal/auth"
)

func registerCronTools(reg *tools.Registry, deps Deps) {
	if deps.Cron == nil {
		return
	}

	nodeReadTool(reg, "cron_list",
		"列出节点的定时任务：各用户 crontab 条目与 systemd timers。",
		objSchema(nodeIDProp, "node_id"),
		func(ctx context.Context, t tools.ToolCtx, raw json.RawMessage, nid uint64) (string, error) {
			info, err := deps.Cron.Info(ctx, t.UserID, nid)
			if err != nil {
				return "", err
			}
			return view("cron", info)
		})

	nodeWriteTool(reg, "cron_add",
		"向当前用户的 crontab 追加一条任务（完整 crontab 行，如 '0 3 * * * /usr/bin/backup.sh'）。高危操作，需审批。",
		auth.PermCronManage, "新增定时任务",
		objSchema(nodeIDProp+`,"entry_line":{"type":"string","description":"完整 crontab 行"}`, "node_id", "entry_line"),
		func(ctx context.Context, t tools.ToolCtx, raw json.RawMessage, nid uint64) (string, error) {
			line, err := strArg(raw, "entry_line")
			if err != nil {
				return "", err
			}
			if err := deps.Cron.AddEntry(ctx, t.UserID, nid, cronClaims(t), line); err != nil {
				return "", err
			}
			return fmt.Sprintf("已在节点 %d 新增定时任务", nid), nil
		})

	nodeWriteTool(reg, "cron_remove",
		"按序号删除一条 crontab 任务（序号来自 cron_list）。高危操作，需审批。",
		auth.PermCronManage, "删除定时任务",
		objSchema(nodeIDProp+`,"index":{"type":"integer"}`, "node_id", "index"),
		func(ctx context.Context, t tools.ToolCtx, raw json.RawMessage, nid uint64) (string, error) {
			var a struct {
				Index int `json:"index"`
			}
			if err := json.Unmarshal(raw, &a); err != nil {
				return "", err
			}
			if err := deps.Cron.RemoveEntry(ctx, t.UserID, nid, cronClaims(t), a.Index); err != nil {
				return "", err
			}
			return fmt.Sprintf("已删除节点 %d 的定时任务 #%d", nid, a.Index), nil
		})

	nodeWriteTool(reg, "cron_set_timer",
		"启用/禁用某个 systemd timer 单元。高危操作，需审批。",
		auth.PermCronManage, "切换 systemd timer",
		objSchema(nodeIDProp+`,"unit":{"type":"string","description":"timer 单元名"},"enable":{"type":"boolean"}`, "node_id", "unit", "enable"),
		func(ctx context.Context, t tools.ToolCtx, raw json.RawMessage, nid uint64) (string, error) {
			var a struct {
				Unit   string `json:"unit"`
				Enable bool   `json:"enable"`
			}
			if err := json.Unmarshal(raw, &a); err != nil || a.Unit == "" {
				return "", fmt.Errorf("unit required")
			}
			if err := deps.Cron.SetTimer(ctx, t.UserID, nid, cronClaims(t), a.Unit, a.Enable); err != nil {
				return "", err
			}
			state := "禁用"
			if a.Enable {
				state = "启用"
			}
			return fmt.Sprintf("已在节点 %d %s timer %s", nid, state, a.Unit), nil
		})
}
