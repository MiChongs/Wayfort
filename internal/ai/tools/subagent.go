package tools

import (
	"context"
	"encoding/json"
	"errors"

	aimodel "github.com/michongs/jumpserver-anonymous/internal/ai/model"
)

// RegisterSubAgentTool exposes the call_subagent primitive that lets a parent
// agent delegate work to another agent (which must have is_sub_agent=true).
// Recursion depth is capped server-side in the runner.
func RegisterSubAgentTool(reg *Registry, deps Deps) {
	if deps.AgentRunner == nil {
		return
	}
	reg.Register(&Tool{
		Name:        "call_subagent",
		Description: "调用另一个已声明为 sub_agent=true 的 agent，让它完成一段独立的子任务并把结果返回。适合在主 agent 里委派专项工作（如 SQL 诊断、安全审计）。",
		Danger:      DangerMedium,
		Schema: json.RawMessage(`{"type":"object","properties":{
			"agent_id":{"type":"integer","description":"sub-agent 的 id"},
			"prompt":{"type":"string","description":"交给子 agent 的指令"},
			"mode":{"type":"string","enum":["plan","normal","bypass"],"description":"子 agent 权限模式；默认沿用父会话"}},
			"required":["agent_id","prompt"]}`),
		Run: func(ctx context.Context, tctx ToolCtx, raw json.RawMessage) (string, error) {
			var a struct {
				AgentID uint64 `json:"agent_id"`
				Prompt  string `json:"prompt"`
				Mode    string `json:"mode"`
			}
			if err := json.Unmarshal(raw, &a); err != nil {
				return "", err
			}
			if a.AgentID == 0 || a.Prompt == "" {
				return "", errors.New("agent_id and prompt required")
			}
			mode := aimodel.PermissionMode(a.Mode)
			result, err := deps.AgentRunner.RunSub(ctx, tctx.ConvID, tctx.UserID, a.AgentID, a.Prompt, mode)
			if err != nil {
				return "", err
			}
			out, _ := Truncate(result)
			return out, nil
		},
	})
}
