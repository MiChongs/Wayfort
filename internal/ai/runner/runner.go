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
	// HistoryTokenBudget caps the approximate token size of the prior-turn
	// history fed back to the model each iteration (system prompt + the new
	// output are budgeted separately by the provider). When the transcript
	// grows past this, the agent's ContextStrategy decides what to drop.
	HistoryTokenBudget int
	// StreamRetries is how many times a failed Stream() *establishment* is
	// retried (transient connection / 5xx). Mid-stream errors are not retried.
	StreamRetries int
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
	if c.HistoryTokenBudget <= 0 {
		c.HistoryTokenBudget = 48000
	}
	if c.StreamRetries < 0 {
		c.StreamRetries = 0
	}
	if c.StreamRetries == 0 {
		c.StreamRetries = 2
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

	capMu    sync.Mutex
	toolCaps map[string]bool // model id → supports tool calling (best-effort, cached)
}

type activeRun struct {
	cancel  context.CancelFunc
	sink    *ChannelSink
	pending map[string]chan bool   // invocationID → approve/reject (tools + plan)
	answers map[string]chan string // invocationID → ask_user free/structured answer
	mu      sync.Mutex
}

func NewFactory(p *provider.Registry, tr *tools.Registry, conv *airepo.ConversationRepo,
	msg *airepo.MessageRepo, inv *airepo.InvocationRepo, agents *airepo.AgentRepo,
	aud *audit.Writer, logger *zap.Logger, cfg Config) *Factory {
	return &Factory{
		Provider: p, Tools: tr, Conv: conv, Msg: msg, Inv: inv,
		Agents: agents, Audit: aud, Logger: logger,
		Cfg: cfg.withDefaults(), running: map[string]*activeRun{},
		toolCaps: map[string]bool{},
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

// Approve / Reject deliver the user's decision into a waiting tool gate (or a
// pending plan presented via exit_plan_mode).
func (f *Factory) Approve(convID, invocationID string) bool { return f.signal(convID, invocationID, true) }
func (f *Factory) Reject(convID, invocationID string) bool  { return f.signal(convID, invocationID, false) }

// Answer delivers the user's reply to a waiting ask_user invocation.
func (f *Factory) Answer(convID, invID, text string) bool {
	f.mu.Lock()
	r, exists := f.running[convID]
	f.mu.Unlock()
	if !exists {
		return false
	}
	r.mu.Lock()
	ch, found := r.answers[invID]
	r.mu.Unlock()
	if !found {
		return false
	}
	select {
	case ch <- text:
		return true
	default:
		return false
	}
}

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
func (f *Factory) Run(ctx context.Context, conv *aimodel.AIConversation, userInput string, images []string) (*ChannelSink, error) {
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
	active := &activeRun{
		cancel:  cancel,
		sink:    sink,
		pending: map[string]chan bool{},
		answers: map[string]chan string{},
	}

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
		if err := f.execute(runCtx, conv, agent, prov, userInput, images, sink, active, mode, 0); err != nil {
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
	prov provider.Provider, userInput string, images []string, sink *ChannelSink, active *activeRun,
	mode aimodel.PermissionMode, depth int) error {
	// Persist the user message first so resume / replay works. Vision input is
	// carried as image_url content parts alongside the text.
	parts := []provider.ContentPart{{Type: "text", Text: userInput}}
	for _, img := range images {
		if img != "" {
			parts = append(parts, provider.ContentPart{Type: "image_url", ImageURL: img})
		}
	}
	userMsg := &aimodel.AIMessage{
		ConversationID: conv.ID, Role: aimodel.RoleUser,
		Content:   jsonEncode(parts),
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
	// Context-window management. truncate_oldest drops the oldest turns;
	// summarize condenses them into a synthetic recap via a cheap model call;
	// none keeps the full transcript.
	switch agent.ContextStrategy {
	case aimodel.CtxStrategyNone:
		// keep full history
	case aimodel.CtxStrategySummarize:
		messages = f.summarizeOverflow(ctx, prov, conv.Model, messages, f.Cfg.HistoryTokenBudget)
	default:
		messages = condenseHistory(messages, aimodel.CtxStrategyTruncateOldest, f.Cfg.HistoryTokenBudget)
	}

	allowedTools := parseStringList(agent.AllowedTools)
	// If the agent is allowed to call sub-agents but we're already at max depth,
	// silently strip the tool so the model can't try.
	if depth >= f.Cfg.MaxSubAgentDepth {
		allowedTools = stripTool(allowedTools, "call_subagent")
	}
	// Auto-inject the interactive primitives for the top-level turn only. A
	// sub-agent runs headless (its events are drained), so pausing for user
	// input there would deadlock — never expose them below depth 0.
	if depth == 0 {
		allowedTools = ensureTool(allowedTools, tools.AskUserToolName)
		if mode == aimodel.PermModePlan {
			allowedTools = ensureTool(allowedTools, tools.ExitPlanModeToolName)
		} else {
			allowedTools = stripTool(allowedTools, tools.ExitPlanModeToolName)
		}
	} else {
		allowedTools = stripTool(allowedTools, tools.AskUserToolName)
		allowedTools = stripTool(allowedTools, tools.ExitPlanModeToolName)
	}
	toolSchemas := f.Tools.ProviderSchemas(allowedTools)
	// Capability gating: don't send tool schemas to a model that can't do tool
	// calling (wastes tokens / risks an API error).
	if len(toolSchemas) > 0 && !f.modelSupportsTools(ctx, prov, conv.Model) {
		toolSchemas = nil
	}

	// Runtime system-prompt addendum teaching the model when to use the
	// interactive primitives (and the Plan-mode contract).
	systemPrompt := agent.SystemPrompt
	if depth == 0 {
		systemPrompt += "\n\n" + interactionGuidance(mode)
	}

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
			System:   systemPrompt,
			Messages: messages,
			Tools:    toolSchemas,
		}
		// Conversation-level overrides (per-turn knobs) trump the agent defaults.
		if conv.Temperature != nil {
			t := *conv.Temperature
			req.Temperature = &t
		} else if agent.Temperature > 0 {
			t := agent.Temperature
			req.Temperature = &t
		}
		if conv.TopP != nil {
			t := *conv.TopP
			req.TopP = &t
		} else if agent.TopP > 0 {
			t := agent.TopP
			req.TopP = &t
		}
		if conv.MaxTokens != nil {
			req.MaxTokens = *conv.MaxTokens
		}
		if conv.ThinkingBudget != nil && *conv.ThinkingBudget > 0 {
			req.ThinkingBudget = *conv.ThinkingBudget
		}
		stream, err := f.streamWithRetry(ctx, prov, req)
		if err != nil {
			return err
		}
		assistant, reasoning, toolCalls, usage, finish, err := f.consumeStream(ctx, stream, sink)
		if err != nil {
			return err
		}
		// Persist assistant turn (reasoning kept for the transcript, not replayed).
		toolCallsJSON, _ := json.Marshal(toolCalls)
		asstMsg := &aimodel.AIMessage{
			ConversationID: conv.ID, Role: aimodel.RoleAssistant,
			Content:       jsonEncode([]provider.ContentPart{{Type: "text", Text: assistant}}),
			Reasoning:     reasoning,
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
		conv.TotalCostMicros += costMicros(conv.Model, usage.in, usage.out)
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
		// Run the tool calls (concurrently when safe), then persist + feed their
		// results back in call order for the next round.
		results := f.runToolBatch(ctx, conv, agent, gate, mode, toolCalls, sink, active, asstMsg.ID)
		for i, tc := range toolCalls {
			toolMsg := &aimodel.AIMessage{
				ConversationID: conv.ID, Role: aimodel.RoleTool,
				ToolCallID:     tc.ID,
				Content:        jsonEncode([]provider.ContentPart{{Type: "text", Text: results[i]}}),
				CreatedAt:      time.Now(),
			}
			_ = f.Msg.Append(ctx, toolMsg)
			conv.MessageCount++
			messages = append(messages, provider.Message{
				Role: provider.RoleTool, ToolCallID: tc.ID, Name: tc.Name,
				Content: []provider.ContentPart{{Type: "text", Text: results[i]}},
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
func (f *Factory) consumeStream(ctx context.Context, stream <-chan provider.Event, sink *ChannelSink) (string, string, []provider.ToolCall, usageAcc, string, error) {
	var text strings.Builder
	var reasoning strings.Builder
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
				reasoning.WriteString(ev.Text)
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
			return text.String(), reasoning.String(), nil, usage, finish, ev.Err
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
	return text.String(), reasoning.String(), calls, usage, finish, nil
}

// runToolBatch executes one assistant turn's tool calls, concurrently when
// safe. If the batch contains an interactive primitive (ask_user /
// exit_plan_mode) — which pauses for user input and, for plan, mutates the
// conversation mode — it falls back to sequential execution. Results are
// returned in call order so the next provider request stays deterministic.
//
// Concurrency safety: each runOneTool persists its own invocation rows
// (gorm pool-safe), registers approval channels under active.mu, and emits to
// the channel-backed sink — none of which races. The shared conv/gate are only
// mutated by the interactive path, which never runs in parallel.
func (f *Factory) runToolBatch(ctx context.Context, conv *aimodel.AIConversation, agent *aimodel.AIAgent,
	gate *tools.PermissionGate, mode aimodel.PermissionMode, calls []provider.ToolCall,
	sink *ChannelSink, active *activeRun, parentMsgID uint64) []string {
	results := make([]string, len(calls))
	interactive := false
	for _, tc := range calls {
		if tc.Name == tools.AskUserToolName || tc.Name == tools.ExitPlanModeToolName {
			interactive = true
			break
		}
	}
	if len(calls) <= 1 || interactive {
		for i, tc := range calls {
			results[i] = f.runOneTool(ctx, conv, agent, gate, mode, tc, sink, active, parentMsgID)
		}
		return results
	}
	var wg sync.WaitGroup
	for i := range calls {
		wg.Add(1)
		go func(i int) {
			defer wg.Done()
			results[i] = f.runOneTool(ctx, conv, agent, gate, mode, calls[i], sink, active, parentMsgID)
		}(i)
	}
	wg.Wait()
	return results
}

// runOneTool dispatches one tool_call, handling permission flow, execution,
// and audit/invocation persistence.
func (f *Factory) runOneTool(ctx context.Context, conv *aimodel.AIConversation, agent *aimodel.AIAgent,
	gate *tools.PermissionGate, mode aimodel.PermissionMode, tc provider.ToolCall,
	sink *ChannelSink, active *activeRun, parentMsgID uint64) string {
	// Interactive primitives are driven by the runner, not executed as tools.
	switch tc.Name {
	case tools.AskUserToolName:
		return f.handleAskUser(ctx, conv, tc, sink, active, parentMsgID)
	case tools.ExitPlanModeToolName:
		return f.handleExitPlanMode(ctx, conv, tc, sink, active, gate, parentMsgID)
	}
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
		ToolCallID:     tc.ID,
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
		tctx := makeToolCtx(conv, agent)
		// Live output streaming: forward fragments to the UI as they arrive.
		tctx.Stream = func(chunk string) {
			sink.Emit(Event{Kind: KindToolOutputDelta, Data: map[string]any{
				"id": tc.ID, "invocation_id": invID, "delta": chunk,
			}})
		}
		out, err := tool.Run(runCtx, tctx, json.RawMessage(tc.Arguments))
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

// handleAskUser pauses the run, emits an ask_user event, and waits for the
// user's structured/free answer (delivered via Factory.Answer). The answer is
// returned to the model as the tool result.
func (f *Factory) handleAskUser(ctx context.Context, conv *aimodel.AIConversation, tc provider.ToolCall,
	sink *ChannelSink, active *activeRun, parentMsgID uint64) string {
	var q struct {
		Question string `json:"question"`
		Options  []struct {
			Label       string `json:"label"`
			Description string `json:"description"`
		} `json:"options"`
		AllowMultiple bool  `json:"allow_multiple"`
		AllowText     *bool `json:"allow_text"`
	}
	_ = json.Unmarshal([]byte(tc.Arguments), &q)
	if strings.TrimSpace(q.Question) == "" {
		return "[error] ask_user 缺少 question"
	}
	invID := newInvID()
	inv := &aimodel.AIToolInvocation{
		ID: invID, ConversationID: conv.ID, MessageID: parentMsgID,
		ToolCallID: tc.ID,
		ToolName:   tools.AskUserToolName, InputJSON: tc.Arguments,
		PermissionMode: conv.PermissionMode, Status: aimodel.InvStatusPending,
		CreatedAt: time.Now(),
	}
	_ = f.Inv.Create(ctx, inv)

	allowText := len(q.Options) == 0
	if q.AllowText != nil {
		allowText = *q.AllowText
	}
	sink.Emit(Event{Kind: KindAskUser, Data: map[string]any{
		"invocation_id":  invID,
		"id":             tc.ID,
		"question":       q.Question,
		"options":        q.Options,
		"allow_multiple": q.AllowMultiple,
		"allow_text":     allowText,
	}})

	ch := make(chan string, 1)
	active.mu.Lock()
	active.answers[invID] = ch
	active.mu.Unlock()
	defer func() {
		active.mu.Lock()
		delete(active.answers, invID)
		active.mu.Unlock()
	}()

	waitCtx, cancel := context.WithTimeout(ctx, 10*time.Minute)
	defer cancel()
	select {
	case ans := <-ch:
		now := time.Now()
		inv.Status = aimodel.InvStatusSucceeded
		inv.OutputText = ans
		inv.CompletedAt = &now
		_ = f.Inv.Update(ctx, inv)
		sink.Emit(Event{Kind: KindToolOutput, Data: map[string]any{"id": tc.ID, "invocation_id": invID, "output": ans}})
		return "用户回答：" + ans
	case <-waitCtx.Done():
		now := time.Now()
		inv.Status = aimodel.InvStatusFailed
		inv.ErrorMessage = "user did not answer in time"
		inv.CompletedAt = &now
		_ = f.Inv.Update(ctx, inv)
		sink.Emit(Event{Kind: KindToolError, Data: map[string]any{"id": tc.ID, "invocation_id": invID, "error": "用户未在时限内回答"}})
		return "[no answer] 用户未在时限内回答；请基于已有信息继续，或稍后再问。"
	}
}

// handleExitPlanMode presents the agent's plan and waits for approval. On
// approval the conversation switches to execute (normal) mode — the complete
// Plan-mode handshake. Reuses the approve/reject signal (bool) plumbing.
func (f *Factory) handleExitPlanMode(ctx context.Context, conv *aimodel.AIConversation, tc provider.ToolCall,
	sink *ChannelSink, active *activeRun, gate *tools.PermissionGate, parentMsgID uint64) string {
	if conv.PermissionMode != aimodel.PermModePlan {
		return "当前不在计划模式，无需审批，可直接按计划执行。"
	}
	var p struct {
		Plan string `json:"plan"`
	}
	_ = json.Unmarshal([]byte(tc.Arguments), &p)
	if strings.TrimSpace(p.Plan) == "" {
		return "[error] exit_plan_mode 缺少 plan"
	}
	invID := newInvID()
	inv := &aimodel.AIToolInvocation{
		ID: invID, ConversationID: conv.ID, MessageID: parentMsgID,
		ToolCallID: tc.ID,
		ToolName:   tools.ExitPlanModeToolName, InputJSON: tc.Arguments,
		PermissionMode: conv.PermissionMode, Status: aimodel.InvStatusPending,
		CreatedAt: time.Now(),
	}
	_ = f.Inv.Create(ctx, inv)

	sink.Emit(Event{Kind: KindPlanPresented, Data: map[string]any{
		"invocation_id": invID, "id": tc.ID, "plan": p.Plan,
	}})

	ch := make(chan bool, 1)
	active.mu.Lock()
	active.pending[invID] = ch
	active.mu.Unlock()
	defer func() {
		active.mu.Lock()
		delete(active.pending, invID)
		active.mu.Unlock()
	}()

	timeout := f.Cfg.ApprovalTimeout
	if timeout < 5*time.Minute {
		timeout = 5 * time.Minute
	}
	waitCtx, cancel := context.WithTimeout(ctx, timeout)
	defer cancel()
	select {
	case ok := <-ch:
		now := time.Now()
		inv.CompletedAt = &now
		if !ok {
			inv.Status = aimodel.InvStatusRejected
			_ = f.Inv.Update(ctx, inv)
			sink.Emit(Event{Kind: KindToolError, Data: map[string]any{"id": tc.ID, "invocation_id": invID, "error": "用户驳回了计划"}})
			return "用户驳回了该计划。请根据可能的顾虑修订（更稳妥的步骤 / 补充前置检查 / 缩小影响面 / 增加回滚），然后重新调用 exit_plan_mode 呈现。"
		}
		inv.Status = aimodel.InvStatusApproved
		ap := time.Now()
		inv.ApprovedAt = &ap
		inv.OutputText = "approved"
		_ = f.Inv.Update(ctx, inv)
		// Switch to execute mode: persist on the conversation + flip the live
		// gate so the rest of this turn (and future turns) can act.
		conv.PermissionMode = aimodel.PermModeNormal
		_ = f.Conv.Update(ctx, conv)
		gate.Mode = aimodel.PermModeNormal
		sink.Emit(Event{Kind: KindToolOutput, Data: map[string]any{"id": tc.ID, "invocation_id": invID, "output": "用户已批准计划，切换到执行模式"}})
		return "用户已批准计划，会话已切换到【执行模式】。现在请按计划逐步执行；高危动作仍会逐项请求用户确认。"
	case <-waitCtx.Done():
		now := time.Now()
		inv.Status = aimodel.InvStatusFailed
		inv.ErrorMessage = "plan approval timed out"
		inv.CompletedAt = &now
		_ = f.Inv.Update(ctx, inv)
		sink.Emit(Event{Kind: KindToolError, Data: map[string]any{"id": tc.ID, "invocation_id": invID, "error": "计划审批超时"}})
		return "[timeout] 计划审批超时；请提示用户在收到计划后尽快批准或驳回。"
	}
}

func ensureTool(in []string, name string) []string {
	for _, s := range in {
		if s == name {
			return in
		}
	}
	return append(in, name)
}

func interactionGuidance(mode aimodel.PermissionMode) string {
	base := "【向用户提问】当关键信息缺失、存在多个可选方案、或动作有歧义时，调用 ask_user 工具向用户提问" +
		"（可附单选/多选选项与可选自由文本），不要凭空假设。"
	if mode == aimodel.PermModePlan {
		return base + "\n\n【计划模式】你当前处于只读计划模式：只能用只读工具调研，禁止任何写操作。" +
			"调研完成后必须调用 exit_plan_mode 工具，把一份分步骤、含前置检查 / 风险 / 回滚的完整执行计划呈现给用户审批。" +
			"用户批准后系统会自动切换到执行模式，你再逐步执行（高危动作仍逐项确认）。"
	}
	return base
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

// streamWithRetry establishes a provider stream, retrying transient setup
// failures with a short linear backoff. Only the *establishment* is retried —
// once events flow, an error is surfaced as-is (partial output may already be
// on the wire).
func (f *Factory) streamWithRetry(ctx context.Context, prov provider.Provider, req provider.Request) (<-chan provider.Event, error) {
	var lastErr error
	for attempt := 0; attempt <= f.Cfg.StreamRetries; attempt++ {
		if ctx.Err() != nil {
			return nil, ctx.Err()
		}
		stream, err := prov.Stream(ctx, req)
		if err == nil {
			return stream, nil
		}
		lastErr = err
		if attempt < f.Cfg.StreamRetries {
			select {
			case <-time.After(time.Duration(300*(attempt+1)) * time.Millisecond):
			case <-ctx.Done():
				return nil, ctx.Err()
			}
		}
	}
	return nil, lastErr
}

// condenseHistory keeps the transcript within a token budget. truncate_oldest
// (the default) drops the oldest turns, snapping the kept window to a user
// message so a tool result never leads without its triggering assistant turn.
// "summarize" currently behaves like truncate_oldest (a real summary would need
// an extra model call); "none" disables trimming.
func condenseHistory(msgs []provider.Message, strategy aimodel.ContextStrategy, budget int) []provider.Message {
	if strategy == aimodel.CtxStrategyNone || budget <= 0 || len(msgs) == 0 {
		return msgs
	}
	kept, _ := splitHistoryAtBudget(msgs, budget)
	return kept
}

// splitHistoryAtBudget returns the newest suffix that fits the token budget
// (snapped to a user-turn boundary so a tool result never leads) plus the older
// messages it dropped. When everything fits, kept = msgs and dropped = nil.
func splitHistoryAtBudget(msgs []provider.Message, budget int) (kept, dropped []provider.Message) {
	if budget <= 0 || len(msgs) == 0 {
		return msgs, nil
	}
	total := 0
	for i := range msgs {
		total += estimateTokens(msgs[i])
	}
	if total <= budget {
		return msgs, nil
	}
	acc := 0
	start := len(msgs)
	for i := len(msgs) - 1; i >= 0; i-- {
		t := estimateTokens(msgs[i])
		if acc+t > budget {
			break
		}
		acc += t
		start = i
	}
	for start < len(msgs) && msgs[start].Role != provider.RoleUser {
		start++
	}
	if start >= len(msgs) {
		start = 0
		for i := len(msgs) - 1; i >= 0; i-- {
			if msgs[i].Role == provider.RoleUser {
				start = i
				break
			}
		}
	}
	return msgs[start:], msgs[:start]
}

// summarizeOverflow implements the "summarize" context strategy: when the
// transcript exceeds the budget, the dropped (older) turns are condensed into a
// single recap message via a cheap model call, prepended to the recent suffix.
// Any failure degrades to truncate_oldest.
func (f *Factory) summarizeOverflow(ctx context.Context, prov provider.Provider, model string, msgs []provider.Message, budget int) []provider.Message {
	if budget <= 0 || len(msgs) == 0 {
		return msgs
	}
	total := 0
	for i := range msgs {
		total += estimateTokens(msgs[i])
	}
	if total <= budget {
		return msgs
	}
	kept, dropped := splitHistoryAtBudget(msgs, budget*3/4) // reserve room for the recap
	if len(dropped) == 0 {
		return kept
	}
	summary, err := f.summarizeMessages(ctx, prov, model, dropped)
	if err != nil || strings.TrimSpace(summary) == "" {
		if f.Logger != nil && err != nil {
			f.Logger.Warn("context summarize failed; truncating instead", zap.Error(err))
		}
		return kept
	}
	out := make([]provider.Message, 0, len(kept)+1)
	out = append(out, provider.Message{
		Role: provider.RoleUser,
		Content: []provider.ContentPart{{Type: "text",
			Text: "【此前对话的摘要（系统自动压缩，供你保持上下文）】\n" + summary + "\n【摘要结束；以下为最近的对话】"}},
	})
	out = append(out, kept...)
	return out
}

func (f *Factory) summarizeMessages(ctx context.Context, prov provider.Provider, model string, msgs []provider.Message) (string, error) {
	var sb strings.Builder
	for _, m := range msgs {
		txt := messageText(m)
		if txt == "" && len(m.ToolCalls) > 0 {
			names := make([]string, 0, len(m.ToolCalls))
			for _, tc := range m.ToolCalls {
				names = append(names, tc.Name)
			}
			txt = "[调用工具: " + strings.Join(names, ", ") + "]"
		}
		if txt == "" {
			continue
		}
		sb.WriteString(string(m.Role))
		sb.WriteString(": ")
		sb.WriteString(txt)
		sb.WriteString("\n")
	}
	body := sb.String()
	if strings.TrimSpace(body) == "" {
		return "", nil
	}
	// Cap the summarization input so it can't itself overflow; keep the tail
	// (closest to the recent turns is most relevant).
	const maxSummarizeInput = 24000
	if len(body) > maxSummarizeInput {
		body = "…(更早内容已省略)…\n" + body[len(body)-maxSummarizeInput:]
	}
	req := provider.Request{
		Model:  model,
		System: "你是对话历史压缩器。把下面的多轮运维对话压缩成简洁的中文要点：用户目标、关键事实与发现、已执行的操作及其结果、尚未完成的事项与下一步。直接给要点，不要寒暄、不要复述本提示。",
		Messages: []provider.Message{{
			Role:    provider.RoleUser,
			Content: []provider.ContentPart{{Type: "text", Text: body}},
		}},
		MaxTokens: 1024,
	}
	stream, err := prov.Stream(ctx, req)
	if err != nil {
		return "", err
	}
	var out strings.Builder
	for ev := range stream {
		switch ev.Type {
		case provider.EvtTextDelta:
			out.WriteString(ev.Text)
		case provider.EvtError:
			return "", ev.Err
		}
	}
	return out.String(), nil
}

func messageText(m provider.Message) string {
	var sb strings.Builder
	for _, p := range m.Content {
		if p.Type == "text" || p.Type == "" {
			sb.WriteString(p.Text)
		}
	}
	return sb.String()
}

// noToolModelSubstrings marks models we KNOW can't do tool calling. We gate on
// this denylist rather than a provider's Tools flag because several providers
// don't report capability flags — defaulting those to "supports tools" avoids
// disabling tools for capable models.
var noToolModelSubstrings = []string{
	"embedding", "embed-", "whisper", "tts-", "dall-e", "dalle", "moderation",
	"text-davinci", "davinci-002", "babbage-002", "-instruct", "rerank",
}

func modelLacksTools(model string) bool {
	m := strings.ToLower(model)
	for _, s := range noToolModelSubstrings {
		if strings.Contains(m, s) {
			return true
		}
	}
	return false
}

// modelSupportsTools best-effort decides whether to send tool schemas. Defaults
// to true unless the model is on the denylist or a capability-reporting
// provider explicitly reports the model has no tools. Cached per model id.
func (f *Factory) modelSupportsTools(ctx context.Context, prov provider.Provider, model string) bool {
	if model == "" {
		return true
	}
	if modelLacksTools(model) {
		return false
	}
	f.capMu.Lock()
	if v, ok := f.toolCaps[model]; ok {
		f.capMu.Unlock()
		return v
	}
	f.capMu.Unlock()

	supported := true
	lctx, cancel := context.WithTimeout(ctx, 4*time.Second)
	models, err := prov.ListModels(lctx)
	cancel()
	if err == nil {
		anyToolFlag, found := false, false
		for _, m := range models {
			if m.Tools {
				anyToolFlag = true
			}
			if m.ID == model {
				found = true
				supported = m.Tools
			}
		}
		// Only trust a negative when the provider reports tool flags for SOME
		// model; otherwise it doesn't populate the field → assume yes.
		if !found || !anyToolFlag {
			supported = true
		}
	}
	f.capMu.Lock()
	f.toolCaps[model] = supported
	f.capMu.Unlock()
	return supported
}

// estimateTokens is a cheap ~4-chars-per-token heuristic plus per-message
// overhead — good enough for budgeting without pulling a real tokenizer.
func estimateTokens(m provider.Message) int {
	n := 0
	for _, p := range m.Content {
		n += len(p.Text)
	}
	for _, tc := range m.ToolCalls {
		n += len(tc.Name) + len(tc.Arguments)
	}
	return n/4 + 8
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
