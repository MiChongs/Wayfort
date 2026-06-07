package runner

import (
	"context"
	"errors"
	"fmt"
	"strings"
	"time"

	"github.com/google/uuid"
	aimodel "github.com/michongs/jumpserver-anonymous/internal/ai/model"
)

// RunSub is invoked by the call_subagent tool. It allocates a child
// conversation, runs the agent synchronously, and returns the final text.
func (f *Factory) RunSub(ctx context.Context, parentConvID string, callerUserID uint64,
	agentID uint64, prompt string, overrideMode aimodel.PermissionMode) (string, error) {
	agent, err := f.Agents.FindByID(ctx, agentID)
	if err != nil || agent == nil {
		return "", fmt.Errorf("sub-agent %d not found", agentID)
	}
	if !agent.IsSubAgent {
		return "", errors.New("agent is not marked as sub_agent")
	}
	mode := overrideMode
	if mode == "" {
		mode = agent.PermissionMode
	}
	if mode == "" {
		mode = aimodel.PermModeNormal
	}

	// Relay coarse sub-agent milestones to the PARENT's live SSE stream so the
	// operator sees what the delegated agent is doing. We deliberately do NOT
	// relay text deltas (the parent would get one card per token) — only start,
	// each tool call, tool errors, and completion. The sub-agent's final text
	// still returns as the call_subagent tool result.
	parentSink := f.Stream(parentConvID)
	relay := func(kind, text string) {
		if parentSink != nil {
			parentSink.Emit(Event{Kind: KindSubAgent, Data: map[string]any{
				"agent": agent.Name, "kind_inner": kind, "text": text,
			}})
		}
	}

	conv := &aimodel.AIConversation{
		ID:                 "subc_" + uuid.NewString(),
		UserID:             callerUserID,
		AgentID:            agentID,
		Title:              "[sub-agent] " + agent.Name,
		PermissionMode:     mode,
		Status:             aimodel.ConvStatusRunning,
		ParentConversation: &parentConvID,
		CreatedAt:          time.Now(),
		UpdatedAt:          time.Now(),
	}
	if err := f.Conv.Create(ctx, conv); err != nil {
		return "", err
	}

	relay("start", "开始执行子任务")
	sink, err := f.Run(ctx, conv, prompt, nil)
	if err != nil {
		return "", err
	}
	// Drain the sink: accumulate assistant text, relay milestones.
	var assistant strings.Builder
	for ev := range sink.C() {
		switch ev.Kind {
		case KindTextDelta:
			if m, ok := ev.Data.(map[string]string); ok {
				assistant.WriteString(m["text"])
			}
		case KindToolCall:
			if m, ok := ev.Data.(map[string]any); ok {
				if name, _ := m["name"].(string); name != "" {
					relay("tool_call", "调用 "+name)
				}
			}
		case KindToolError:
			relay("tool_error", "工具执行失败")
		}
	}
	relay("done", "子任务完成")
	return assistant.String(), nil
}
