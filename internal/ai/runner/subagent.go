package runner

import (
	"context"
	"errors"
	"fmt"
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

	sink, err := f.Run(ctx, conv, prompt)
	if err != nil {
		return "", err
	}
	// Drain the sink, accumulate the assistant text.
	var assistant string
	for ev := range sink.C() {
		if ev.Kind == KindTextDelta {
			if m, ok := ev.Data.(map[string]string); ok {
				assistant += m["text"]
			}
		}
	}
	return assistant, nil
}
