package runner

import (
	"context"
	"crypto/rand"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"strings"
	"sync"
	"time"

	aimodel "github.com/michongs/jumpserver-anonymous/internal/ai/model"
	"github.com/michongs/jumpserver-anonymous/internal/ai/provider"
	airepo "github.com/michongs/jumpserver-anonymous/internal/ai/repo"
	"github.com/michongs/jumpserver-anonymous/internal/ai/tools"
	"github.com/michongs/jumpserver-anonymous/internal/audit"
	"go.uber.org/zap"
)

// Config bundles tunables.
type Config struct {
	MaxIterations    int
	MaxSubAgentDepth int
	ToolTimeout      time.Duration
	ApprovalTimeout  time.Duration
	SSEKeepalive     time.Duration
}

func (c Config) withDefaults() Config {
	if c.MaxIterations <= 0 {
		c.MaxIterations = 20
	}
	if c.MaxSubAgentDepth <= 0 {
		c.MaxSubAgentDepth = 2
	}
	if c.ToolTimeout <= 0 {
		c.ToolTimeout = 60 * time.Second
	}
	if c.ApprovalTimeout <= 0 {
		c.ApprovalTimeout = 2 * time.Minute
	}
	if c.SSEKeepalive <= 0 {
		c.SSEKeepalive = 15 * time.Second
	}
	return c
}

// Factory composes runner instances and tracks live ones for cancellation.
type Factory struct {
	Provider      *provider.Registry
	Tools         *tools.Registry
	Conv          *airepo.ConversationRepo
	Msg           *airepo.MessageRepo
	Inv           *airepo.InvocationRepo
	Agents        *airepo.AgentRepo
	Audit         *audit.Writer
	Logger        *zap.Logger
	Cfg           Config

	mu      sync.Mutex
	running map[string]*activeRun
}

type activeRun struct {
	cancel  context.CancelFunc
	sink    *ChannelSink
	pending map[string]chan bool // invocationID → approve/reject signals
	mu      sync.Mutex
}

func NewFactory(p *provider.Registry, tr *tools.Registry, conv *airepo.ConversationRepo,
	msg *airepo.MessageRepo, inv *airepo.InvocationRepo, agents *airepo.AgentRepo,
	aud *audit.Writer, logger *zap.Logger, cfg Config) *Factory {
	return &Factory{
		Provider: p, Tools: tr, Conv: conv, Msg: msg, Inv: inv,
		Agents: agents, Audit: aud, Logger: logger,
		Cfg: cfg.withDefaults(), running: map[string]*activeRun{},
	}
}

// Cancel aborts the in-flight runner for convID, if any.
func (f *Factory) Cancel(convID string) {
	f.mu.Lock()
	r, ok := f.running[convID]
	f.mu.Unlock()
	if ok && r.cancel != nil {
		r.cancel()
	}
}

// Approve / Reject deliver the user's decision into a waiting tool gate.
func (f *Factory) Approve(convID, invocationID string) bool { return f.signal(convID, invocationID, true) }
func (f *Factory) Reject(convID, invocationID string) bool  { return f.signal(convID, invocationID, false) }

func (f *Factory) signal(convID, invID string, ok bool) bool {
	f.mu.Lock()
	r, exists := f.running[convID]
	f.mu.Unlock()
	if !exists {
		return false
	}
	r.mu.Lock()
	ch, found := r.pending[invID]
	r.mu.Unlock()
	if !found {
		return false
	}
	select {
	case ch <- ok:
		return true
	default:
		return false
	}
}

// Stream returns the in-flight Sink for a convID (used by the SSE handler when
// it (re)attaches to an already-running run).
func (f *Factory) Stream(convID string) *ChannelSink {
	f.mu.Lock()
	defer f.mu.Unlock()
	if r, ok := f.running[convID]; ok {
		return r.sink
	}
	return nil
}

// Run kicks off one turn for the conversation and returns a Sink the caller
// can drain. The Sink closes when the turn is over.
func (f *Factory) Run(ctx context.Context, conv *aimodel.AIConversation, userInput string) (*ChannelSink, error) {
	agent, err := f.Agents.FindByID(ctx, conv.AgentID)
	if err != nil || agent == nil {
		return nil, fmt.Errorf("agent not found: %w", err)
	}
	prov, provRow, err := f.Provider.Resolve(ctx, conv.UserID, ptrOrNil(conv.ProviderID), agent)
	if err != nil {
		return nil, err
	}
	if conv.ProviderID == 0 {
		conv.ProviderID = provRow.ID
	}
	if conv.Model == "" {
		conv.Model = orStr(agent.DefaultModel, provRow.DefaultModel)
	}
	mode := conv.PermissionMode
	if mode == "" {
		mode = agent.PermissionMode
	}
	if mode == "" {
		mode = aimodel.PermModeNormal
	}

	sink := NewChannelSink(128)
	runCtx, cancel := context.WithCancel(context.Background())
	active := &activeRun{cancel: cancel, sink: sink, pending: map[string]chan bool{}}

	f.mu.Lock()
	f.running[conv.ID] = active
	f.mu.Unlock()

	go func() {
		defer func() {
			f.mu.Lock()
			delete(f.running, conv.ID)
			f.mu.Unlock()
			sink.Close()
		}()
		if err := f.execute(runCtx, conv, agent, prov, userInput, sink, active, mode, 0); err != nil {
			f.Logger.Warn("ai runner failed", zap.String("conv", conv.ID), zap.Error(err))
			sink.Emit(Event{Kind: KindError, Data: map[string]string{"error": err.Error()}})
		}
		sink.Emit(Event{Kind: KindDone, Data: map[string]any{}})
	}()
	return sink, nil
}

// execute runs the actual model + tool loop. depth is increased when invoked
// as a sub-agent — top-level calls pass 0.
func (f *Factory) execute(ctx context.Context, conv *aimodel.AIConversation, agent *aimodel.AIAgent,
	prov provider.Provider, userInput string, sink *ChannelSink, active *activeRun,
	mode aimodel.PermissionMode, depth int) error {
	// Persist the user message first so resume / replay works.
	userMsg := &aimodel.AIMessage{
		ConversationID: conv.ID, Role: aimodel.RoleUser,
		Content: jsonEncode([]provider.ContentPart{{Type: "text", Text: userInput}}),
		CreatedAt: time.Now(),
	}
	if err := f.Msg.Append(ctx, userMsg); err != nil {
		return err
	}
	conv.MessageCount++
	conv.Status = aimodel.ConvStatusRunning
	_ = f.Conv.Update(ctx, conv)

	sink.Emit(Event{Kind: KindMessageStart, Data: map[string]any{"conversation_id": conv.ID, "model": conv.Model}})

	// Load full history (system_prompt + prior turns) to feed the model.
	history, err := f.Msg.ListByConv(ctx, conv.ID)
	if err != nil {
		return err
	}
	messages := mapHistoryToProvider(history)

	allowedTools := parseStringList(agent.AllowedTools)
	// If the agent is allowed to call sub-agents but we're already at max depth,
	// silently strip the tool so the model can't try.
	if depth >= f.Cfg.MaxSubAgentDepth {
		allowedTools = stripTool(allowedTools, "call_subagent")
	}
	toolSchemas := f.Tools.ProviderSchemas(allowedTools)

	gate := &tools.PermissionGate{
		Mode:    mode,
		Asset:   nil, // we let the tool's own AssetAction declaration force the gate; the gate field is read by Authorize directly
		RBAC:    nil,
		InvRepo: f.Inv,
		Approve: &approvalAdapter{factory: f, convID: conv.ID, sink: sink, active: active},
		ApprovalTimeout: f.Cfg.ApprovalTimeout,
	}
	// Inject the live Asset/RBAC resolvers from the tool deps the registry holds.
	// They are NOT global state; instead the tools themselves consult them via
	// ToolCtx — we just give the gate the same handles. The gate uses them only
	// for asset/perm pre-checks.
	gate.Asset = ToolDepsView.Asset
	gate.RBAC = ToolDepsView.RBAC

	for iter := 0; iter < agent.MaxIterations; iter++ {
		if ctx.Err() != nil {
			return ctx.Err()
		}
		req := provider.Request{
			Model:    conv.Model,
			System:   agent.SystemPrompt,
			Messages: messages,
			Tools:    toolSchemas,
		}
		if agent.Temperature > 0 {
			t := agent.Temperature
			req.Temperature = &t
		}
		if agent.TopP > 0 {
			t := agent.TopP
			req.TopP = &t
		}
		stream, err := prov.Stream(ctx, req)
		if err != nil {
			return err
		}
		assistant, toolCalls, usage, finish, err := f.consumeStream(ctx, stream, sink)
		if err != nil {
			return err
		}
		// Persist assistant turn.
		toolCallsJSON, _ := json.Marshal(toolCalls)
		asstMsg := &aimodel.AIMessage{
			ConversationID: conv.ID, Role: aimodel.RoleAssistant,
			Content:       jsonEncode([]provider.ContentPart{{Type: "text", Text: assistant}}),
			ToolCalls:     string(toolCallsJSON),
			InputTokens:   usage.in, OutputTokens: usage.out, FinishReason: finish,
			CreatedAt: time.Now(),
		}
		if err := f.Msg.Append(ctx, asstMsg); err != nil {
			return err
		}
		conv.MessageCount++
		conv.TotalInputTokens += uint64(usage.in)
		conv.TotalOutputTokens += uint64(usage.out)
		_ = f.Conv.Update(ctx, conv)
		messages = append(messages, provider.Message{
			Role: provider.RoleAssistant,
			Content: []provider.ContentPart{{Type: "text", Text: assistant}},
			ToolCalls: toolCalls,
		})
		if len(toolCalls) == 0 {
			sink.Emit(Event{Kind: KindMessageEnd, Data: map[string]any{"finish_reason": finish}})
			conv.Status = aimodel.ConvStatusIdle
			_ = f.Conv.Update(ctx, conv)
			return nil
		}
		// Run each tool call, append result messages.
		for _, tc := range toolCalls {
			result := f.runOneTool(ctx, conv, agent, gate, mode, tc, sink, asstMsg.ID)
			toolMsg := &aimodel.AIMessage{
				ConversationID: conv.ID, Role: aimodel.RoleTool,
				ToolCallID:     tc.ID,
				Content:        jsonEncode([]provider.ContentPart{{Type: "text", Text: result}}),
				CreatedAt:      time.Now(),
			}
			_ = f.Msg.Append(ctx, toolMsg)
			conv.MessageCount++
			messages = append(messages, provider.Message{
				Role: provider.RoleTool, ToolCallID: tc.ID, Name: tc.Name,
				Content: []provider.ContentPart{{Type: "text", Text: result}},
			})
		}
	}
	sink.Emit(Event{Kind: KindMessageEnd, Data: map[string]any{"finish_reason": "max_iterations"}})
	conv.Status = aimodel.ConvStatusIdle
	_ = f.Conv.Update(ctx, conv)
	return nil
}

type usageAcc struct{ in, out uint32 }

// consumeStream drains a provider.Event channel, forwards events to the sink,
// and returns the accumulated assistant text + tool calls.
func (f *Factory) consumeStream(ctx context.Context, stream <-chan provider.Event, sink *ChannelSink) (string, []provider.ToolCall, usageAcc, string, error) {
	var text strings.Builder
	type pending struct {
		id   string
		name string
		args strings.Builder
	}
	pendings := map[string]*pending{}
	order := []string{}
	usage := usageAcc{}
	finish := ""
	for ev := range stream {
		switch ev.Type {
		case provider.EvtReasoningStart:
			sink.Emit(Event{Kind: KindReasoningStart, Data: map[string]any{}})
		case provider.EvtReasoningDelta:
			if ev.Text != "" {
				sink.Emit(Event{Kind: KindReasoningDelta, Data: map[string]string{"text": ev.Text}})
			}
		case provider.EvtReasoningEnd:
			sink.Emit(Event{Kind: KindReasoningEnd, Data: map[string]any{}})
		case provider.EvtTextDelta:
			if ev.Text != "" {
				text.WriteString(ev.Text)
				sink.Emit(Event{Kind: KindTextDelta, Data: map[string]string{"text": ev.Text}})
			}
		case provider.EvtToolCallStart:
			id := ev.ToolCallID
			if _, ok := pendings[id]; !ok {
				pendings[id] = &pending{id: id, name: ev.ToolName}
				order = append(order, id)
			}
			sink.Emit(Event{Kind: KindToolCall, Data: map[string]any{
				"id": ev.ToolCallID, "name": ev.ToolName,
			}})
		case provider.EvtToolArgsDelta:
			if p, ok := pendings[ev.ToolCallID]; ok {
				p.args.WriteString(ev.ToolArgs)
			}
		case provider.EvtToolCallEnd:
			if p, ok := pendings[ev.ToolCallID]; ok {
				if p.args.Len() == 0 && ev.ToolArgs != "" {
					p.args.WriteString(ev.ToolArgs)
				}
				if p.name == "" {
					p.name = ev.ToolName
				}
			} else {
				pendings[ev.ToolCallID] = &pending{id: ev.ToolCallID, name: ev.ToolName, args: strings.Builder{}}
				if ev.ToolArgs != "" {
					pendings[ev.ToolCallID].args.WriteString(ev.ToolArgs)
				}
				order = append(order, ev.ToolCallID)
			}
		case provider.EvtUsage:
			usage.in += ev.InputTokens
			usage.out += ev.OutputTokens
			sink.Emit(Event{Kind: KindUsage, Data: map[string]any{"input_tokens": ev.InputTokens, "output_tokens": ev.OutputTokens}})
		case provider.EvtMessageEnd:
			finish = ev.FinishReason
		case provider.EvtError:
			return text.String(), nil, usage, finish, ev.Err
		}
	}
	calls := make([]provider.ToolCall, 0, len(order))
	for _, id := range order {
		p := pendings[id]
		args := p.args.String()
		if args == "" {
			args = "{}"
		}
		calls = append(calls, provider.ToolCall{ID: id, Name: p.name, Arguments: args})
	}
	_ = ctx
	return text.String(), calls, usage, finish, nil
}

// runOneTool dispatches one tool_call, handling permission flow, execution,
// and audit/invocation persistence.
func (f *Factory) runOneTool(ctx context.Context, conv *aimodel.AIConversation, agent *aimodel.AIAgent,
	gate *tools.PermissionGate, mode aimodel.PermissionMode, tc provider.ToolCall,
	sink *ChannelSink, parentMsgID uint64) string {
	tool := f.Tools.Get(tc.Name)
	if tool == nil {
		return fmt.Sprintf("[error] tool %q not registered", tc.Name)
	}
	// Authorise.
	decision, denyReason, err := gate.Authorize(ctx, tool, json.RawMessage(tc.Arguments), conv.UserID)
	if err != nil {
		return fmt.Sprintf("[error] %s", err.Error())
	}
	invID := newInvID()
	inv := &aimodel.AIToolInvocation{
		ID:             invID,
		ConversationID: conv.ID,
		MessageID:      parentMsgID,
		ToolName:       tc.Name,
		InputJSON:      tc.Arguments,
		PermissionMode: mode,
		Status:         aimodel.InvStatusPending,
		CreatedAt:      time.Now(),
	}
	_ = f.Inv.Create(ctx, inv)

	switch decision {
	case tools.DecisionDeny:
		inv.Status = aimodel.InvStatusRejected
		inv.ErrorMessage = denyReason
		now := time.Now()
		inv.CompletedAt = &now
		_ = f.Inv.Update(ctx, inv)
		sink.Emit(Event{Kind: KindToolError, Data: map[string]any{"id": tc.ID, "invocation_id": invID, "error": denyReason}})
		return "[denied] " + denyReason

	case tools.DecisionDryRun:
		inv.Status = aimodel.InvStatusDryRun
		var output string
		if tool.DryRun != nil {
			out, err := tool.DryRun(ctx, makeToolCtx(conv, agent), json.RawMessage(tc.Arguments))
			if err != nil {
				output = "[dry-run error] " + err.Error()
			} else {
				output = out
			}
		} else {
			output = fmt.Sprintf("[plan mode] would call %s with %s", tc.Name, tc.Arguments)
		}
		inv.OutputText = output
		now := time.Now()
		inv.CompletedAt = &now
		_ = f.Inv.Update(ctx, inv)
		sink.Emit(Event{Kind: KindToolOutput, Data: map[string]any{"id": tc.ID, "invocation_id": invID, "output": output, "dry_run": true}})
		return output

	case tools.DecisionApprove:
		summary := buildApprovalSummary(tc.Name, tc.Arguments)
		sink.Emit(Event{Kind: KindPermissionRequired, Data: map[string]any{
			"invocation_id": invID, "tool": tc.Name, "summary": summary,
			"timeout_sec": int(f.Cfg.ApprovalTimeout.Seconds()),
			"arguments":   json.RawMessage(tc.Arguments),
		}})
		approved, err := gate.Wait(ctx, inv, summary)
		if err != nil {
			inv.Status = aimodel.InvStatusRejected
			inv.ErrorMessage = err.Error()
		}
		if !approved {
			inv.Status = aimodel.InvStatusRejected
			now := time.Now()
			inv.CompletedAt = &now
			_ = f.Inv.Update(ctx, inv)
			sink.Emit(Event{Kind: KindToolError, Data: map[string]any{"id": tc.ID, "invocation_id": invID, "error": "user rejected"}})
			return "[rejected] user denied this tool call"
		}
		inv.Status = aimodel.InvStatusApproved
		approvedAt := time.Now()
		inv.ApprovedAt = &approvedAt
		_ = f.Inv.Update(ctx, inv)
		fallthrough

	case tools.DecisionRun:
		inv.Status = aimodel.InvStatusRunning
		_ = f.Inv.Update(ctx, inv)
		sink.Emit(Event{Kind: KindToolStart, Data: map[string]any{"id": tc.ID, "invocation_id": invID}})
		runCtx, cancel := context.WithTimeout(ctx, f.Cfg.ToolTimeout)
		out, err := tool.Run(runCtx, makeToolCtx(conv, agent), json.RawMessage(tc.Arguments))
		cancel()
		now := time.Now()
		inv.CompletedAt = &now
		inv.DurationMs = uint32(time.Since(inv.CreatedAt).Milliseconds())
		if err != nil {
			inv.Status = aimodel.InvStatusFailed
			inv.ErrorMessage = err.Error()
			_ = f.Inv.Update(ctx, inv)
			sink.Emit(Event{Kind: KindToolError, Data: map[string]any{"id": tc.ID, "invocation_id": invID, "error": err.Error()}})
			return "[error] " + err.Error()
		}
		truncated, was := tools.Truncate(out)
		inv.Status = aimodel.InvStatusSucceeded
		inv.OutputText = truncated
		inv.OutputTruncated = was
		_ = f.Inv.Update(ctx, inv)
		sink.Emit(Event{Kind: KindToolOutput, Data: map[string]any{"id": tc.ID, "invocation_id": invID, "output": truncated, "truncated": was}})
		return truncated
	}
	return "[error] unhandled decision"
}

// approvalAdapter bridges PermissionGate.Wait to the runner's pending map.
type approvalAdapter struct {
	factory *Factory
	convID  string
	sink    *ChannelSink
	active  *activeRun
}

func (a *approvalAdapter) RequestApproval(ctx context.Context, inv *aimodel.AIToolInvocation, _ string) (bool, error) {
	ch := make(chan bool, 1)
	a.active.mu.Lock()
	a.active.pending[inv.ID] = ch
	a.active.mu.Unlock()
	defer func() {
		a.active.mu.Lock()
		delete(a.active.pending, inv.ID)
		a.active.mu.Unlock()
	}()
	select {
	case ok := <-ch:
		return ok, nil
	case <-ctx.Done():
		return false, errors.New("approval timed out")
	}
}

// --- helpers ---

func mapHistoryToProvider(rows []aimodel.AIMessage) []provider.Message {
	out := make([]provider.Message, 0, len(rows))
	for _, r := range rows {
		var parts []provider.ContentPart
		_ = json.Unmarshal([]byte(r.Content), &parts)
		var tcs []provider.ToolCall
		if r.ToolCalls != "" {
			_ = json.Unmarshal([]byte(r.ToolCalls), &tcs)
		}
		out = append(out, provider.Message{
			Role: provider.MessageRole(r.Role), Content: parts,
			ToolCallID: r.ToolCallID, ToolCalls: tcs,
		})
	}
	return out
}

func jsonEncode(parts []provider.ContentPart) string {
	b, _ := json.Marshal(parts)
	return string(b)
}

func parseStringList(raw string) []string {
	if raw == "" {
		return nil
	}
	var out []string
	if err := json.Unmarshal([]byte(raw), &out); err != nil {
		// also accept comma-separated
		for _, s := range strings.Split(raw, ",") {
			s = strings.TrimSpace(s)
			if s != "" {
				out = append(out, s)
			}
		}
	}
	return out
}

func stripTool(in []string, name string) []string {
	out := in[:0]
	for _, s := range in {
		if s != name {
			out = append(out, s)
		}
	}
	return out
}

func newInvID() string {
	var b [10]byte
	_, _ = rand.Read(b[:])
	return "inv_" + hex.EncodeToString(b[:])
}

func ptrOrNil(u uint64) *uint64 {
	if u == 0 {
		return nil
	}
	return &u
}

func orStr(a, b string) string {
	if a != "" {
		return a
	}
	return b
}

func buildApprovalSummary(toolName, raw string) string {
	var m map[string]any
	if err := json.Unmarshal([]byte(raw), &m); err == nil {
		switch toolName {
		case "ssh_exec":
			if cmd, ok := m["command"].(string); ok {
				return fmt.Sprintf("在节点 %v 执行: %s", m["node_id"], cmd)
			}
		case "sftp_write":
			return fmt.Sprintf("写入节点 %v 的 %v", m["node_id"], m["path"])
		case "sftp_delete":
			return fmt.Sprintf("删除节点 %v 的 %v", m["node_id"], m["path"])
		case "session_terminate":
			return fmt.Sprintf("终止会话 %v", m["session_id"])
		case "portforward_create":
			return fmt.Sprintf("为节点 %v 开端口转发", m["node_id"])
		}
	}
	return fmt.Sprintf("调用工具 %s", toolName)
}

func makeToolCtx(conv *aimodel.AIConversation, _ *aimodel.AIAgent) tools.ToolCtx {
	return tools.ToolCtx{UserID: conv.UserID, ConvID: conv.ID}
}
