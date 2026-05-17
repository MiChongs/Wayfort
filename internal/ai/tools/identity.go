package tools

import (
	"context"
	"encoding/json"
	"fmt"
	"sort"
	"strings"
	"time"

	"github.com/michongs/jumpserver-anonymous/internal/asset"
	"github.com/michongs/jumpserver-anonymous/internal/auth"
	"github.com/michongs/jumpserver-anonymous/internal/repo"
)

// RegisterIdentityTools adds read-only tools that introspect the calling
// user's identity, permissions, login history and anomaly events. Useful for
// agents diagnosing access problems or running security-audit flows.
func RegisterIdentityTools(reg *Registry, deps Deps) {
	reg.Register(&Tool{
		Name: "whoami_audit",
		Description: "返回当前调用者（user）的概览：用户名、角色、权限码、可访问节点数、是否管理员。" +
			"用于排查权限错误或回答\"我有什么权限\"类问题。",
		Danger: DangerLow,
		Schema: json.RawMessage(`{"type":"object","properties":{},"required":[]}`),
		Run: func(ctx context.Context, tctx ToolCtx, _ json.RawMessage) (string, error) {
			out := map[string]any{
				"user_id":  tctx.UserID,
				"username": tctx.Username,
			}
			if deps.Users != nil {
				if u, err := deps.Users.FindByID(ctx, tctx.UserID); err == nil && u != nil {
					out["display_name"] = u.DisplayName
					out["is_admin"] = u.IsAdmin
					out["disabled"] = u.Disabled
					out["mfa_enforced"] = u.MFAEnforced
					out["passkey_only"] = u.PasskeyOnly
				}
			}
			if deps.RBAC != nil {
				perms, err := deps.RBAC.Permissions(ctx, tctx.UserID)
				if err == nil {
					keys := make([]string, 0, len(perms))
					for k := range perms {
						keys = append(keys, k)
					}
					sort.Strings(keys)
					out["permissions"] = keys
				}
			}
			if deps.Asset != nil {
				ids, all, err := deps.Asset.VisibleNodeIDs(ctx, tctx.UserID, asset.ActionConnect)
				if err == nil {
					out["assets_all"] = all
					out["assets_visible_count"] = len(ids)
				}
			}
			b, _ := json.Marshal(out)
			return string(b), nil
		},
	})

	reg.Register(&Tool{
		Name: "login_history_query",
		Description: "查询用户登录历史（默认查自己；admin 可加 user_id 查别人）。" +
			"返回最近 N 条登录尝试，包含时间 / IP / UA / 结果 / MFA 方法 / 异常标记。",
		Danger: DangerLow,
		Schema: json.RawMessage(`{"type":"object","properties":{
			"user_id":{"type":"integer","description":"可选；admin 才可查别人"},
			"result":{"type":"string","enum":["success","fail","mfa_required","mfa_failed","locked"]},
			"anomaly_only":{"type":"boolean","description":"只看 anomaly=true"},
			"limit":{"type":"integer","minimum":1,"maximum":200}},
			"required":[]}`),
		Run: func(ctx context.Context, tctx ToolCtx, raw json.RawMessage) (string, error) {
			if deps.LoginHist == nil {
				return "", fmt.Errorf("login history repo not configured")
			}
			var a struct {
				UserID      *uint64 `json:"user_id"`
				Result      string  `json:"result"`
				AnomalyOnly bool    `json:"anomaly_only"`
				Limit       int     `json:"limit"`
			}
			_ = json.Unmarshal(raw, &a)
			target := a.UserID
			if target != nil && *target != tctx.UserID {
				// querying another user requires audit-read.
				if ok, _ := deps.RBAC.Has(ctx, tctx.UserID, auth.PermAuditRead); !ok {
					return "", fmt.Errorf("permission denied: querying other users requires %s", auth.PermAuditRead)
				}
			} else {
				me := tctx.UserID
				target = &me
			}
			rows, err := deps.LoginHist.Query(ctx, repo.LoginHistoryFilter{
				UserID: target, Result: a.Result, AnomalyOnly: a.AnomalyOnly, Limit: a.Limit,
			})
			if err != nil {
				return "", err
			}
			b, _ := json.Marshal(map[string]any{"logins": rows, "count": len(rows)})
			out, _ := Truncate(string(b))
			return out, nil
		},
	})

	reg.Register(&Tool{
		Name: "anomaly_list",
		Description: "列出最近被打上 anomaly=true 的登录尝试（新 IP / 新 UA / 新国家等）。" +
			"安全审计专用。",
		Danger:       DangerLow,
		RequiredPerm: auth.PermAuditRead,
		Schema: json.RawMessage(`{"type":"object","properties":{
			"user_id":{"type":"integer","description":"可选；只看某个用户"},
			"limit":{"type":"integer","minimum":1,"maximum":200}},
			"required":[]}`),
		Run: func(ctx context.Context, tctx ToolCtx, raw json.RawMessage) (string, error) {
			if deps.LoginHist == nil {
				return "", fmt.Errorf("login history repo not configured")
			}
			var a struct {
				UserID *uint64 `json:"user_id"`
				Limit  int     `json:"limit"`
			}
			_ = json.Unmarshal(raw, &a)
			_ = tctx
			rows, err := deps.LoginHist.Query(ctx, repo.LoginHistoryFilter{
				UserID: a.UserID, AnomalyOnly: true, Limit: a.Limit,
			})
			if err != nil {
				return "", err
			}
			// Aggregate a quick summary.
			byUser := map[string]int{}
			byIP := map[string]int{}
			for _, r := range rows {
				byUser[r.Username]++
				if r.IP != "" {
					byIP[r.IP]++
				}
			}
			b, _ := json.Marshal(map[string]any{
				"anomalies":   rows,
				"count":       len(rows),
				"by_user":     byUser,
				"by_ip":       byIP,
				"generated":   time.Now().Format(time.RFC3339),
			})
			out, _ := Truncate(string(b))
			return out, nil
		},
	})
}

// formatRBACSummary turns the resolver output into a short string for
// inclusion in plain-text bodies. Keeps the JSON tool output focused on
// fields the model can pattern-match.
func formatRBACSummary(perms map[string]struct{}) string {
	if len(perms) == 0 {
		return "(no permissions)"
	}
	out := make([]string, 0, len(perms))
	for k := range perms {
		out = append(out, k)
	}
	sort.Strings(out)
	return strings.Join(out, ", ")
}

// Reference suppresses unused-import warnings if a helper is removed during
// future refactors. Cheap and explicit.
var _ = formatRBACSummary
