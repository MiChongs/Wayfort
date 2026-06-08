package optools

import (
	"context"
	"encoding/json"

	"github.com/michongs/jumpserver-anonymous/internal/ai/tools"
	"github.com/michongs/jumpserver-anonymous/internal/auth"
)

func registerSecAuditTools(reg *tools.Registry, deps Deps) {
	if deps.SecAudit == nil {
		return
	}

	nodeReadTool(reg, "secaudit_scan",
		"对节点执行安全基线扫描，返回总分与逐项检查（SSH 配置、账户、权限、内核加固等）及修复建议。",
		objSchema(nodeIDProp, "node_id"),
		func(ctx context.Context, t tools.ToolCtx, raw json.RawMessage, nid uint64) (string, error) {
			rep, err := deps.SecAudit.Report(ctx, t.UserID, nid)
			if err != nil {
				return "", err
			}
			return view("security_report", rep)
		})

	nodeWriteTool(reg, "secaudit_apply",
		"对某一项安全检查应用建议的加固修复(check_id 来自 secaudit_scan)。高危操作，需审批。",
		auth.PermSecurityManage, "应用安全加固",
		objSchema(nodeIDProp+`,"check_id":{"type":"string","description":"检查项 ID"}`, "node_id", "check_id"),
		func(ctx context.Context, t tools.ToolCtx, raw json.RawMessage, nid uint64) (string, error) {
			checkID, err := strArg(raw, "check_id")
			if err != nil {
				return "", err
			}
			out, err := deps.SecAudit.Apply(ctx, t.UserID, nid, secauditClaims(t), checkID)
			if err != nil {
				return "", err
			}
			if out == "" {
				out = "已应用加固: " + checkID
			}
			return out, nil
		})
}
