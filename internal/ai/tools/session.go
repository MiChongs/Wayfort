package tools

import (
	"context"
	"encoding/json"
	"fmt"

	"github.com/michongs/jumpserver-anonymous/internal/auth"
	"github.com/michongs/jumpserver-anonymous/internal/repo"
)

// RegisterSessionTools adds the session/audit/portforward catalogue queries.
func RegisterSessionTools(reg *Registry, deps Deps) {
	reg.Register(&Tool{
		Name:        "session_list",
		Description: "列出最近的 SSH/Telnet/RDP/VNC 会话记录。",
		Danger:      DangerLow,
		RequiredPerm: auth.PermSessionList,
		Schema: json.RawMessage(`{"type":"object","properties":{
			"status":{"type":"string","enum":["active","closed","errored","terminated"]},
			"limit":{"type":"integer","minimum":1,"maximum":200}},
			"required":[]}`),
		Run: func(ctx context.Context, tctx ToolCtx, raw json.RawMessage) (string, error) {
			var a struct {
				Status string `json:"status"`
				Limit  int    `json:"limit"`
			}
			_ = json.Unmarshal(raw, &a)
			if a.Limit == 0 {
				a.Limit = 50
			}
			rows, err := deps.Sessions.List(ctx, repo.ListSessionFilter{Status: a.Status, Limit: a.Limit})
			if err != nil {
				return "", err
			}
			b, _ := json.Marshal(map[string]any{"sessions": rows, "count": len(rows)})
			out, _ := Truncate(string(b))
			return out, nil
		},
	})

	reg.Register(&Tool{
		Name:        "audit_query",
		Description: "查询审计日志（按 session_id 或 kind）。",
		Danger:      DangerLow,
		RequiredPerm: auth.PermAuditRead,
		Schema: json.RawMessage(`{"type":"object","properties":{
			"session_id":{"type":"string"},
			"limit":{"type":"integer","minimum":1,"maximum":500}},
			"required":[]}`),
		Run: func(ctx context.Context, tctx ToolCtx, raw json.RawMessage) (string, error) {
			var a struct {
				SessionID string `json:"session_id"`
				Limit     int    `json:"limit"`
			}
			_ = json.Unmarshal(raw, &a)
			rows, err := deps.AuditRepo.List(ctx, a.SessionID, a.Limit)
			if err != nil {
				return "", err
			}
			b, _ := json.Marshal(map[string]any{"logs": rows, "count": len(rows)})
			out, _ := Truncate(string(b))
			return out, nil
		},
	})

	reg.Register(&Tool{
		Name:        "portforward_create",
		Description: "在网关本地分配一个 TCP 转发端口指向目标节点。需用户确认。",
		Danger:      DangerHigh,
		RequiredPerm: auth.PermPortForward,
		Schema: json.RawMessage(`{"type":"object","properties":{
			"node_id":{"type":"integer"},
			"ttl_sec":{"type":"integer","minimum":60,"maximum":86400}},
			"required":["node_id"]}`),
		Run: func(ctx context.Context, tctx ToolCtx, raw json.RawMessage) (string, error) {
			var a struct {
				NodeID uint64 `json:"node_id"`
				TTL    int    `json:"ttl_sec"`
			}
			if err := json.Unmarshal(raw, &a); err != nil {
				return "", err
			}
			if a.NodeID == 0 {
				return "", fmt.Errorf("node_id required")
			}
			id, host, port, err := deps.PortFwdMgr.Create(ctx, tctx.UserID, tctx.Username, a.NodeID, a.TTL)
			if err != nil {
				return "", err
			}
			return fmt.Sprintf("port-forward %s opened at %s:%d", id, host, port), nil
		},
		DryRun: func(_ context.Context, _ ToolCtx, raw json.RawMessage) (string, error) {
			var a struct {
				NodeID uint64 `json:"node_id"`
			}
			_ = json.Unmarshal(raw, &a)
			return fmt.Sprintf("[plan mode] would open a TCP forwarder to node %d", a.NodeID), nil
		},
	})

	reg.Register(&Tool{
		Name:         "portforward_list",
		Description:  "列出当前用户活动中的端口转发（id / 节点 / 本地端口 / 过期时间）。只读。",
		Danger:       DangerLow,
		RequiredPerm: auth.PermPortForward,
		Schema:       json.RawMessage(`{"type":"object","properties":{},"required":[]}`),
		Run: func(ctx context.Context, tctx ToolCtx, _ json.RawMessage) (string, error) {
			if deps.PortFwdMgr == nil {
				return "", fmt.Errorf("port forwarder not enabled")
			}
			rows, err := deps.PortFwdMgr.ListByUser(ctx, tctx.UserID)
			if err != nil {
				return "", err
			}
			b, _ := json.Marshal(map[string]any{"forwards": rows, "count": len(rows)})
			out, _ := Truncate(string(b))
			return out, nil
		},
	})

	reg.Register(&Tool{
		Name:         "portforward_delete",
		Description:  "关闭一个之前开过的端口转发。",
		Danger:       DangerHigh,
		RequiredPerm: auth.PermPortForward,
		Schema: json.RawMessage(`{"type":"object","properties":{
			"id":{"type":"string"}},
			"required":["id"]}`),
		Run: func(ctx context.Context, tctx ToolCtx, raw json.RawMessage) (string, error) {
			var a struct {
				ID string `json:"id"`
			}
			if err := json.Unmarshal(raw, &a); err != nil {
				return "", err
			}
			if err := deps.PortFwdMgr.Close(ctx, a.ID); err != nil {
				return "", err
			}
			return "closed " + a.ID, nil
		},
	})
}
