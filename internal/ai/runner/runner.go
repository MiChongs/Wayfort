package runner

import (
	"context"
	"crypto/rand"
	"crypto/sha256"
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
	// MaxAgenticIterations is the hard step ceiling for a long-horizon run (one
	// that has engaged the plan via update_plan). Turn-based runs that never
	// touch the plan stay capped at the agent's MaxIterations. WallClockBudget
	// bounds the same run by elapsed time. Both are circuit breakers against
	// runaway loops, alongside no-progress detection.
	MaxAgenticIterations int
	WallClockBudget      time.Duration
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
	if c.MaxAgenticIterations <= 0 {
		c.MaxAgenticIterations = 60
	}
	if c.WallClockBudget <= 0 {
		c.WallClockBudget = 20 * time.Minute
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
	Tasks         *airepo.TaskRepo
	Agents        *airepo.AgentRepo
	Audit         *audit.Writer
	Logger        *zap.Logger
	Cfg           Config

	mu      sync.Mutex
	running map[string]*activeRun

	capMu     sync.Mutex
	modelCaps map[string]provider.ModelCapabilities // "kind:model" → full capability descriptor
}

type activeRun struct {
	cancel  context.CancelFunc
	sink    *ChannelSink
	pending map[string]chan bool   // invocationID → approve/reject (tools + plan)
	answers map[string]chan string // invocationID → ask_user free/structured answer
	mu      sync.Mutex
}

func NewFactory(p *provider.Registry, tr *tools.Registry, conv *airepo.ConversationRepo,
	msg *airepo.MessageRepo, inv *airepo.InvocationRepo, tasks *airepo.TaskRepo, agents *airepo.AgentRepo,
	aud *audit.Writer, logger *zap.Logger, cfg Config) *Factory {
	return &Factory{
		Provider: p, Tools: tr, Conv: conv, Msg: msg, Inv: inv, Tasks: tasks,
		Agents: agents, Audit: aud, Logger: logger,
		Cfg: cfg.withDefaults(), running: map[string]*activeRun{},
		modelCaps: map[string]provider.ModelCapabilities{},
	}
}

// Capabilities resolves (and caches) what a provider+model can do: per-kind
// defaults, layered with model-substring rules and provider-reported flags.
// Used by the runner to gate tools / vision / thinking / caching per turn.
func (f *Factory) Capabilities(ctx context.Context, prov provider.Provider, model string) provider.ModelCapabilities {
	key := string(prov.Kind()) + ":" + model
	f.capMu.Lock()
	if c, ok := f.modelCaps[key]; ok {
		f.capMu.Unlock()
		return c
	}
	f.capMu.Unlock()

	caps := provider.DefaultCapabilities(prov.Kind())
	lm := strings.ToLower(model)
	if modelLacksTools(model) {
		caps.Tools = false
	}
	if strings.Contains(lm, "reasoner") || strings.Contains(lm, "-r1") || strings.Contains(lm, "qwq") ||
		strings.Contains(lm, "deepseek-r") || strings.Contains(lm, "thinking") {
		caps.Reasoning = true
	}
	if strings.Contains(lm, "-vl") || strings.Contains(lm, "vision") || strings.Contains(lm, "llava") {
		caps.Vision = true
	}
	if caps.Tokenizer == "tiktoken" && encodingForModel(model) == "" {
		caps.Tokenizer = "heuristic"
	}
	// Provider-reported flags refine the guess when the gateway populates them.
	lctx, cancel := context.WithTimeout(ctx, 4*time.Second)
	models, err := prov.ListModels(lctx)
	cancel()
	if err == nil {
		anyTool := false
		for _, mi := range models {
			if mi.Tools {
				anyTool = true
				break
			}
		}
		for _, mi := range models {
			if mi.ID == model {
				if anyTool {
					caps.Tools = mi.Tools
				}
				if mi.Vision {
					caps.Vision = true
				}
				if mi.MaxOutput > 0 {
					caps.MaxOutput = mi.MaxOutput
				}
				if mi.ContextWindow > 0 {
					caps.ContextWindow = mi.ContextWindow
				}
				break
			}
		}
	}
	f.capMu.Lock()
	f.modelCaps[key] = caps
	f.capMu.Unlock()
	return caps
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

// Run kicks off one turn for the conversation (appending the user message) and
// returns a Sink the caller can drain. The Sink closes when the turn is over.
func (f *Factory) Run(ctx context.Context, conv *aimodel.AIConversation, userInput string, images []string) (*ChannelSink, error) {
	agent, prov, mode, err := f.resolveRun(ctx, conv)
	if err != nil {
		return nil, err
	}
	return f.launch(conv, func(runCtx context.Context, sink *ChannelSink, active *activeRun) error {
		return f.execute(runCtx, conv, agent, prov, userInput, images, nil, sink, active, mode, 0)
	}), nil
}

// Rerun re-runs the conversation's current tail WITHOUT appending a new user
// message (regenerate). The caller must have trimmed the prior assistant turn so
// the tail ends at a user message.
func (f *Factory) Rerun(ctx context.Context, conv *aimodel.AIConversation) (*ChannelSink, error) {
	agent, prov, mode, err := f.resolveRun(ctx, conv)
	if err != nil {
		return nil, err
	}
	return f.launch(conv, func(runCtx context.Context, sink *ChannelSink, active *activeRun) error {
		return f.executeLoop(runCtx, conv, agent, prov, sink, active, mode, 0)
	}), nil
}

// Branch appends `text` as a new user message that is a sibling of branchParentID
// (i.e. ParentID = the edited message's ParentID), sets the active leaf, and
// runs — forking the conversation without destroying the original branch.
func (f *Factory) Branch(ctx context.Context, conv *aimodel.AIConversation, text string, branchParentID *uint64) (*ChannelSink, error) {
	agent, prov, mode, err := f.resolveRun(ctx, conv)
	if err != nil {
		return nil, err
	}
	return f.launch(conv, func(runCtx context.Context, sink *ChannelSink, active *activeRun) error {
		return f.execute(runCtx, conv, agent, prov, text, nil, branchParentID, sink, active, mode, 0)
	}), nil
}

// resolveRun loads the agent + provider and resolves the effective model/mode,
// filling provider/model defaults onto the conversation. Shared by Run/Rerun/Branch.
func (f *Factory) resolveRun(ctx context.Context, conv *aimodel.AIConversation) (*aimodel.AIAgent, provider.Provider, aimodel.PermissionMode, error) {
	agent, err := f.Agents.FindByID(ctx, conv.AgentID)
	if err != nil || agent == nil {
		return nil, nil, "", fmt.Errorf("agent not found: %w", err)
	}
	prov, provRow, err := f.Provider.Resolve(ctx, conv.UserID, ptrOrNil(conv.ProviderID), agent)
	if err != nil {
		return nil, nil, "", err
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
	return agent, prov, mode, nil
}

// launch registers the live run, spawns the work goroutine, and returns the
// sink. Shared by Run/Rerun/Branch so the running-map + done/error emission are
// identical across entry points.
func (f *Factory) launch(conv *aimodel.AIConversation, work func(ctx context.Context, sink *ChannelSink, active *activeRun) error) *ChannelSink {
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
		if err := work(runCtx, sink, active); err != nil {
			f.Logger.Warn("ai runner failed", zap.String("conv", conv.ID), zap.Error(err))
			sink.Emit(Event{Kind: KindError, Data: map[string]string{"error": err.Error()}})
		}
		sink.Emit(Event{Kind: KindDone, Data: map[string]any{}})
	}()
	return sink
}

// IsRunning reports whether a live run already exists for the conversation —
// callers (regenerate/branch) 409 instead of spawning a second run that would
// overwrite the activeRun slot and orphan its channels.
func (f *Factory) IsRunning(convID string) bool {
	f.mu.Lock()
	defer f.mu.Unlock()
	_, ok := f.running[convID]
	return ok
}

// execute persists the incoming user message (linking it into the active branch
// when one exists), then runs the model+tool loop. depth is increased when
// invoked as a sub-agent — top-level calls pass 0. branchParentID, when set,
// makes the new user message a sibling branch of that parent.
func (f *Factory) execute(ctx context.Context, conv *aimodel.AIConversation, agent *aimodel.AIAgent,
	prov provider.Provider, userInput string, images []string, branchParentID *uint64,
	sink *ChannelSink, active *activeRun, mode aimodel.PermissionMode, depth int) error {
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
	// Branch linkage: an explicit branch parent forks a sibling; otherwise chain
	// onto the current leaf when the conversation is already branched. Linear
	// conversations leave ParentID nil (id-order history), unchanged behavior.
	if branchParentID != nil {
		userMsg.ParentID = branchParentID
	} else if conv.ActiveLeafMessageID != nil {
		userMsg.ParentID = conv.ActiveLeafMessageID
	}
	if err := f.Msg.Append(ctx, userMsg); err != nil {
		return err
	}
	conv.MessageCount++
	if branchParentID != nil || conv.ActiveLeafMessageID != nil {
		leaf := userMsg.ID
		conv.ActiveLeafMessageID = &leaf
	}
	conv.Status = aimodel.ConvStatusRunning
	_ = f.Conv.Update(ctx, conv)

	return f.executeLoop(ctx, conv, agent, prov, sink, active, mode, depth)
}

// executeLoop runs the model+tool loop over the conversation's current tail. It
// is shared by execute (after appending a user message), Rerun (regenerate, no
// new user message), and Branch.
func (f *Factory) executeLoop(ctx context.Context, conv *aimodel.AIConversation, agent *aimodel.AIAgent,
	prov provider.Provider, sink *ChannelSink, active *activeRun, mode aimodel.PermissionMode, depth int) error {
	conv.Status = aimodel.ConvStatusRunning
	_ = f.Conv.Update(ctx, conv)
	sink.Emit(Event{Kind: KindMessageStart, Data: map[string]any{"conversation_id": conv.ID, "model": conv.Model}})

	// Load history (system_prompt + prior turns) to feed the model — the active
	// branch path when the conversation is branched, else the full linear list.
	branched := conv.ActiveLeafMessageID != nil
	var history []aimodel.AIMessage
	var err error
	if branched {
		history, err = f.Msg.ListBranch(ctx, conv.ID, *conv.ActiveLeafMessageID)
	} else {
		history, err = f.Msg.ListByConv(ctx, conv.ID)
	}
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
		messages = f.applyRollingSummary(ctx, prov, conv, history, f.Cfg.HistoryTokenBudget)
	default:
		messages = condenseHistory(conv.Model, messages, aimodel.CtxStrategyTruncateOldest, f.Cfg.HistoryTokenBudget)
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
		// The plan/task tracker drives long-horizon self-execution; only the
		// top-level agent has a panel consumer (sub-agents run headless).
		allowedTools = ensureTool(allowedTools, tools.UpdatePlanToolName)
		if mode == aimodel.PermModePlan {
			allowedTools = ensureTool(allowedTools, tools.ExitPlanModeToolName)
		} else {
			allowedTools = stripTool(allowedTools, tools.ExitPlanModeToolName)
		}
	} else {
		allowedTools = stripTool(allowedTools, tools.AskUserToolName)
		allowedTools = stripTool(allowedTools, tools.ExitPlanModeToolName)
		allowedTools = stripTool(allowedTools, tools.UpdatePlanToolName)
	}
	// Resolve the model's capabilities once per turn and gate request features.
	caps := f.Capabilities(ctx, prov, conv.Model)
	toolSchemas := f.Tools.ProviderSchemas(allowedTools)
	if len(toolSchemas) > 0 && !caps.Tools {
		toolSchemas = nil
	}
	// Strip image content for text-only models so the provider doesn't 400.
	if !caps.Vision {
		messages = stripImages(messages)
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

	// Long-horizon execution state. planEngaged flips when the agent calls
	// update_plan, which lifts the step ceiling from the agent's MaxIterations to
	// the hard agentic cap and enables the self-drive nudge. Four circuit
	// breakers bound the run: step cap, wall-clock, no-progress fingerprint, and
	// a single continuation nudge.
	hardCap := f.Cfg.MaxAgenticIterations
	if hardCap < agent.MaxIterations {
		hardCap = agent.MaxIterations
	}
	deadline := time.Now().Add(f.Cfg.WallClockBudget)
	planEngaged := false
	nudged := false
	needTitle := titleIsDefault(conv.Title)
	var lastFingerprint string
	repeatRuns := 0

	for iter := 0; ; iter++ {
		if ctx.Err() != nil {
			return ctx.Err()
		}
		stepCap := agent.MaxIterations
		if planEngaged {
			stepCap = hardCap
		}
		if iter >= stepCap {
			return f.finishTurn(ctx, conv, sink, "max_iterations")
		}
		if time.Now().After(deadline) {
			return f.finishTurn(ctx, conv, sink, "wall_clock_budget")
		}
		// Keep the context window bounded across a long run (cheap; a no-op when
		// already under budget). The strategy-aware condense ran once before the
		// loop; this guards unbounded growth as tool results accumulate.
		if iter > 0 {
			messages = condenseHistory(conv.Model, messages, aimodel.CtxStrategyTruncateOldest, f.Cfg.HistoryTokenBudget)
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
		if conv.ThinkingBudget != nil && *conv.ThinkingBudget > 0 && caps.Reasoning {
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
			InputTokens:   usage.in, OutputTokens: usage.out,
			CacheReadTokens: usage.cacheRead, CacheWriteTokens: usage.cacheWrite,
			Model:        conv.Model,
			FinishReason: finish,
			CreatedAt:    time.Now(),
		}
		turnCost := costMicros(conv.Model, usage.in, usage.out, usage.cacheRead, usage.cacheWrite)
		asstMsg.CostMicros = turnCost
		if branched && conv.ActiveLeafMessageID != nil {
			asstMsg.ParentID = conv.ActiveLeafMessageID
		}
		if err := f.Msg.Append(ctx, asstMsg); err != nil {
			return err
		}
		conv.MessageCount++
		if branched {
			leaf := asstMsg.ID
			conv.ActiveLeafMessageID = &leaf
		}
		conv.TotalInputTokens += uint64(usage.in)
		conv.TotalOutputTokens += uint64(usage.out)
		conv.TotalCacheReadTokens += uint64(usage.cacheRead)
		conv.TotalCacheWriteTokens += uint64(usage.cacheWrite)
		conv.TotalCostMicros += turnCost
		_ = f.Conv.Update(ctx, conv)
		// Auto-name an untitled conversation after its first assistant turn — a
		// detached, best-effort cheap model call (must never delay/fail the turn).
		if needTitle && conv.MessageCount >= 2 {
			needTitle = false
			cid := conv.ID
			go func() { _, _ = f.GenerateTitle(context.Background(), cid) }()
		}
		messages = append(messages, provider.Message{
			Role: provider.RoleAssistant,
			Content: []provider.ContentPart{{Type: "text", Text: assistant}},
			ToolCalls: toolCalls,
		})
		if len(toolCalls) == 0 {
			// Self-drive: if the plan still has open steps but the model stopped
			// emitting tools, nudge it to continue — exactly once — then let it
			// finish if it stalls again.
			if planEngaged && !nudged && f.planHasIncomplete(ctx, conv.ID) {
				nudged = true
				messages = append(messages, provider.Message{
					Role: provider.RoleUser,
					Content: []provider.ContentPart{{Type: "text",
						Text: "计划中仍有未完成的步骤。请继续执行下一步；若已确认全部完成，请调用 update_plan 标记完成，并给出最终结论。"}},
				})
				continue
			}
			return f.finishTurn(ctx, conv, sink, finish)
		}
		// No-progress circuit breaker: identical assistant output + tool calls for
		// three consecutive iterations means the agent is stuck looping.
		fp := runFingerprint(assistant, toolCalls)
		if fp == lastFingerprint {
			repeatRuns++
		} else {
			repeatRuns = 0
			lastFingerprint = fp
		}
		if repeatRuns >= 2 {
			return f.finishTurn(ctx, conv, sink, "no_progress")
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
			if branched && conv.ActiveLeafMessageID != nil {
				toolMsg.ParentID = conv.ActiveLeafMessageID
			}
			_ = f.Msg.Append(ctx, toolMsg)
			conv.MessageCount++
			if branched {
				leaf := toolMsg.ID
				conv.ActiveLeafMessageID = &leaf
			}
			messages = append(messages, provider.Message{
				Role: provider.RoleTool, ToolCallID: tc.ID, Name: tc.Name,
				Content: []provider.ContentPart{{Type: "text", Text: results[i]}},
			})
			if tc.Name == tools.UpdatePlanToolName {
				planEngaged = true
			}
		}
	}
}

// finishTurn emits the terminal message_end, flips the conversation to idle, and
// returns nil. Shared by every loop exit (normal completion + each circuit
// breaker) so the SSE stream always closes with a finish_reason.
func (f *Factory) finishTurn(ctx context.Context, conv *aimodel.AIConversation, sink *ChannelSink, reason string) error {
	sink.Emit(Event{Kind: KindMessageEnd, Data: map[string]any{"finish_reason": reason}})
	conv.Status = aimodel.ConvStatusIdle
	_ = f.Conv.Update(ctx, conv)
	return nil
}

// planHasIncomplete reports whether the conversation's plan still has pending or
// active tasks — used to decide the one-shot self-drive nudge.
func (f *Factory) planHasIncomplete(ctx context.Context, convID string) bool {
	if f.Tasks == nil {
		return false
	}
	tasks, err := f.Tasks.ListByConv(ctx, convID)
	if err != nil {
		return false
	}
	for _, t := range tasks {
		if t.Status == aimodel.TaskPending || t.Status == aimodel.TaskActive {
			return true
		}
	}
	return false
}

// runFingerprint hashes an iteration's assistant text + tool calls so the runner
// can detect a stuck loop (identical output three times running).
func runFingerprint(assistant string, calls []provider.ToolCall) string {
	h := sha256.New()
	h.Write([]byte(assistant))
	for _, tc := range calls {
		h.Write([]byte(tc.Name))
		h.Write([]byte(tc.Arguments))
	}
	return hex.EncodeToString(h.Sum(nil))
}

type usageAcc struct{ in, out, cacheRead, cacheWrite uint32 }

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
			usage.cacheRead += ev.CacheReadTokens
			usage.cacheWrite += ev.CacheWriteTokens
			sink.Emit(Event{Kind: KindUsage, Data: map[string]any{
				"input_tokens":       ev.InputTokens,
				"output_tokens":      ev.OutputTokens,
				"cache_read_tokens":  ev.CacheReadTokens,
				"cache_write_tokens": ev.CacheWriteTokens,
			}})
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
		// ask_user / exit_plan_mode pause for input; update_plan mutates the
		// shared plan table — all three must run on the sequential lane.
		if tc.Name == tools.AskUserToolName || tc.Name == tools.ExitPlanModeToolName || tc.Name == tools.UpdatePlanToolName {
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
	case tools.UpdatePlanToolName:
		return f.handleUpdatePlan(ctx, conv, tc, sink)
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
			out, err := tool.DryRun(ctx, makeToolCtx(ctx, conv, agent), json.RawMessage(tc.Arguments))
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
		tctx := makeToolCtx(ctx, conv, agent)
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

// handleUpdatePlan persists the long-horizon agent's full task list (full-array
// replace) and broadcasts it to the task panel via KindPlanUpdate. It mutates
// shared state but does not pause, so it runs on the sequential tool lane. The
// returned echo nudges the model to keep executing.
func (f *Factory) handleUpdatePlan(ctx context.Context, conv *aimodel.AIConversation, tc provider.ToolCall, sink *ChannelSink) string {
	if f.Tasks == nil {
		return "[error] 计划存储未初始化"
	}
	var p struct {
		Tasks []struct {
			Title  string `json:"title"`
			Status string `json:"status"`
			Detail string `json:"detail"`
		} `json:"tasks"`
	}
	if err := json.Unmarshal([]byte(tc.Arguments), &p); err != nil {
		return "[error] update_plan 参数解析失败：" + err.Error()
	}
	tasks := make([]aimodel.AITask, 0, len(p.Tasks))
	for _, t := range p.Tasks {
		title := strings.TrimSpace(t.Title)
		if title == "" {
			continue
		}
		st := aimodel.TaskStatus(strings.TrimSpace(t.Status))
		if !aimodel.ValidTaskStatus(st) {
			st = aimodel.TaskPending
		}
		tasks = append(tasks, aimodel.AITask{Title: title, Status: st, Detail: strings.TrimSpace(t.Detail)})
	}
	saved, err := f.Tasks.ReplaceAll(ctx, conv.ID, tasks)
	if err != nil {
		return "[error] 计划保存失败：" + err.Error()
	}
	done, active, total := 0, 0, len(saved)
	var activeTitle string
	for _, t := range saved {
		switch t.Status {
		case aimodel.TaskDone, aimodel.TaskSkipped:
			done++
		case aimodel.TaskActive:
			active++
			if activeTitle == "" {
				activeTitle = t.Title
			}
		}
	}
	sink.Emit(Event{Kind: KindPlanUpdate, Data: map[string]any{
		"conversation_id": conv.ID,
		"tasks":           saved,
		"summary":         map[string]int{"total": total, "done": done, "active": active},
	}})
	msg := fmt.Sprintf("计划已更新：共 %d 步，已完成 %d", total, done)
	if activeTitle != "" {
		msg += "，进行中：" + activeTitle
	}
	if done < total {
		msg += "。请继续执行下一步。"
	}
	return msg
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
	plan := "\n\n【执行计划 / 长程自主】当任务包含多个步骤时，先调用 update_plan 把目标拆解为完整的有序步骤清单（status=pending）；" +
		"开始执行某一步前把它标为 active，完成后标 done（失败 failed / 跳过 skipped），随做随更新——同一时刻只一个 active。" +
		"计划会作为任务面板实时展示给用户。请连续自主地执行各步骤（依次调用所需工具），直到全部完成再给出最终结论，不要做一步就停下等待用户。"
	if mode == aimodel.PermModePlan {
		return base + "\n\n【计划模式】你当前处于只读计划模式：只能用只读工具调研，禁止任何写操作。" +
			"调研完成后必须调用 exit_plan_mode 工具，把一份分步骤、含前置检查 / 风险 / 回滚的完整执行计划呈现给用户审批。" +
			"用户批准后系统会自动切换到执行模式；届时请先用 update_plan 把已批准的计划落为任务清单，再逐步自主执行（高危动作仍逐项确认）。"
	}
	return base + plan
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

// stripImages removes image content parts (used when the target model has no
// vision capability, so a text-only endpoint doesn't reject the request).
func stripImages(msgs []provider.Message) []provider.Message {
	out := make([]provider.Message, len(msgs))
	for i, m := range msgs {
		hasImg := false
		for _, p := range m.Content {
			if p.Type == "image_url" || p.Type == "image" {
				hasImg = true
				break
			}
		}
		if !hasImg {
			out[i] = m
			continue
		}
		filtered := make([]provider.ContentPart, 0, len(m.Content))
		for _, p := range m.Content {
			if p.Type == "image_url" || p.Type == "image" {
				continue
			}
			filtered = append(filtered, p)
		}
		m.Content = filtered
		out[i] = m
	}
	return out
}

// streamWithRetry establishes a provider stream, retrying transient setup
// failures with a short linear backoff. Only the *establishment* is retried —
// once events flow, an error is surfaced as-is (partial output may already be
// on the wire).
func (f *Factory) streamWithRetry(ctx context.Context, prov provider.Provider, req provider.Request) (<-chan provider.Event, error) {
	var lastErr error
	const base = 300 * time.Millisecond
	for attempt := 0; attempt <= f.Cfg.StreamRetries; attempt++ {
		if ctx.Err() != nil {
			return nil, ctx.Err()
		}
		stream, err := prov.Stream(ctx, req)
		if err == nil {
			return stream, nil
		}
		lastErr = err
		// Don't waste retries on a permanent error (bad key, unknown model, 400).
		if !isTransientErr(err) {
			return nil, err
		}
		if attempt < f.Cfg.StreamRetries {
			backoff := base * time.Duration(1<<attempt) // exponential
			if backoff > 3*time.Second {
				backoff = 3 * time.Second
			}
			select {
			case <-time.After(backoff):
			case <-ctx.Done():
				return nil, ctx.Err()
			}
		}
	}
	return nil, lastErr
}

// isTransientErr classifies a Stream() establishment error as worth retrying
// (transient network / rate-limit / 5xx) vs. permanent (auth / bad request).
func isTransientErr(err error) bool {
	if err == nil {
		return false
	}
	s := strings.ToLower(err.Error())
	for _, k := range []string{
		"timeout", "deadline", "eof", "connection reset", "connection refused",
		"temporary", "overloaded", "rate limit", "too many requests",
		"429", "500", "502", "503", "504", "529",
	} {
		if strings.Contains(s, k) {
			return true
		}
	}
	return false
}

// condenseHistory keeps the transcript within a token budget. truncate_oldest
// (the default) drops the oldest turns, snapping the kept window to a user
// message so a tool result never leads without its triggering assistant turn.
// "none" disables trimming. Token counts use the model's tokenizer (tiktoken for
// OpenAI-family, heuristic otherwise).
func condenseHistory(model string, msgs []provider.Message, strategy aimodel.ContextStrategy, budget int) []provider.Message {
	if strategy == aimodel.CtxStrategyNone || budget <= 0 || len(msgs) == 0 {
		return msgs
	}
	kept, _ := splitHistoryAtBudget(model, msgs, budget)
	return kept
}

// splitHistoryAtBudget returns the newest suffix that fits the token budget
// (snapped to a user-turn boundary so a tool result never leads) plus the older
// messages it dropped. When everything fits, kept = msgs and dropped = nil.
func splitHistoryAtBudget(model string, msgs []provider.Message, budget int) (kept, dropped []provider.Message) {
	if budget <= 0 || len(msgs) == 0 {
		return msgs, nil
	}
	total := 0
	for i := range msgs {
		total += countTokens(model, msgs[i])
	}
	if total <= budget {
		return msgs, nil
	}
	acc := 0
	start := len(msgs)
	for i := len(msgs) - 1; i >= 0; i-- {
		t := countTokens(model, msgs[i])
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

// applyRollingSummary implements a stateful "summarize" context strategy: when
// the transcript exceeds the budget, the older turns are dropped and folded into
// a persisted RunningSummary on the conversation. Only the NEWLY-dropped span
// (id > SummarizedUpToMessageID) is summarized each time, so cost stays bounded
// instead of re-summarizing from scratch. Any failure degrades to truncate.
func (f *Factory) applyRollingSummary(ctx context.Context, prov provider.Provider, conv *aimodel.AIConversation,
	history []aimodel.AIMessage, budget int) []provider.Message {
	messages := mapHistoryToProvider(history)
	if budget <= 0 || len(messages) == 0 {
		return messages
	}
	total := 0
	for i := range messages {
		total += countTokens(conv.Model, messages[i])
	}
	if total <= budget {
		return messages // everything fits — no drop, no summary needed
	}
	kept, dropped := splitHistoryAtBudget(conv.Model, messages, budget*3/4) // reserve room for the recap
	droppedCount := len(dropped)
	if droppedCount == 0 || droppedCount > len(history) {
		return kept
	}
	// history and messages are index-aligned (one provider.Message per row).
	droppedHistory := history[:droppedCount]
	var newlyDropped []aimodel.AIMessage
	maxID := conv.SummarizedUpToMessageID
	for _, m := range droppedHistory {
		if m.ID > conv.SummarizedUpToMessageID {
			newlyDropped = append(newlyDropped, m)
		}
		if m.ID > maxID {
			maxID = m.ID
		}
	}
	summary := conv.RunningSummary
	if len(newlyDropped) > 0 {
		folded, err := f.foldSummary(ctx, prov, conv.Model, conv.RunningSummary, mapHistoryToProvider(newlyDropped))
		if err != nil || strings.TrimSpace(folded) == "" {
			if f.Logger != nil && err != nil {
				f.Logger.Warn("rolling summarize failed; truncating instead", zap.Error(err))
			}
			return condenseHistory(conv.Model, messages, aimodel.CtxStrategyTruncateOldest, budget)
		}
		summary = folded
		conv.RunningSummary = summary
		conv.SummarizedUpToMessageID = maxID
		conv.SummaryTokenEstimate = len(summary)/4 + 8
		_ = f.Conv.Update(ctx, conv)
	}
	if strings.TrimSpace(summary) == "" {
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

// foldSummary merges the prior running summary with the newly-dropped turns into
// an updated summary via one cheap model call.
func (f *Factory) foldSummary(ctx context.Context, prov provider.Provider, model, prior string, newMsgs []provider.Message) (string, error) {
	msgs := newMsgs
	if strings.TrimSpace(prior) != "" {
		msgs = append([]provider.Message{{
			Role:    provider.RoleAssistant,
			Content: []provider.ContentPart{{Type: "text", Text: "【已有摘要，请在其基础上并入下面的新增对话】\n" + prior}},
		}}, newMsgs...)
	}
	return f.summarizeMessages(ctx, prov, model, msgs)
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

// titleIsDefault reports whether a conversation still has its placeholder title
// (empty or the "新对话" default the create handler assigns).
func titleIsDefault(t string) bool {
	t = strings.TrimSpace(t)
	return t == "" || t == "新对话"
}

// GenerateTitle names a conversation from its opening turns via a cheap one-shot
// model call, persists just the title column (no clobbering the live run's other
// fields), and emits KindTitleUpdate to any attached stream. Best-effort: every
// failure path returns quietly. Also exposed via POST /conversations/:id/autotitle.
func (f *Factory) GenerateTitle(ctx context.Context, convID string) (string, error) {
	ctx, cancel := context.WithTimeout(ctx, 20*time.Second)
	defer cancel()
	conv, err := f.Conv.FindByID(ctx, convID)
	if err != nil || conv == nil {
		return "", err
	}
	agent, err := f.Agents.FindByID(ctx, conv.AgentID)
	if err != nil || agent == nil {
		return "", err
	}
	prov, _, err := f.Provider.Resolve(ctx, conv.UserID, ptrOrNil(conv.ProviderID), agent)
	if err != nil {
		return "", err
	}
	msgs, err := f.Msg.Last(ctx, convID, 4)
	if err != nil {
		return "", err
	}
	var sb strings.Builder
	for _, m := range msgs {
		if m.Role != aimodel.RoleUser && m.Role != aimodel.RoleAssistant {
			continue
		}
		t := strings.TrimSpace(extractMessageText(m.Content))
		if t == "" {
			continue
		}
		sb.WriteString(string(m.Role))
		sb.WriteString("：")
		if len(t) > 800 {
			t = t[:800]
		}
		sb.WriteString(t)
		sb.WriteString("\n")
	}
	if strings.TrimSpace(sb.String()) == "" {
		return "", nil
	}
	req := provider.Request{
		Model:  conv.Model,
		System: "给下面这段对话起一个简短的中文标题，概括主题。只输出标题本身：不超过 16 个字，不要引号、标点、前后缀或解释。",
		Messages: []provider.Message{{
			Role:    provider.RoleUser,
			Content: []provider.ContentPart{{Type: "text", Text: sb.String()}},
		}},
		MaxTokens: 32,
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
	title := sanitizeTitle(out.String())
	if title == "" {
		return "", nil
	}
	if err := f.Conv.UpdateTitle(ctx, convID, title); err != nil {
		return "", err
	}
	if s := f.Stream(convID); s != nil {
		s.Emit(Event{Kind: KindTitleUpdate, Data: map[string]any{"conversation_id": convID, "title": title}})
	}
	return title, nil
}

// sanitizeTitle trims the model's title output to a single clean line, stripping
// wrapping quotes and clamping the length.
func sanitizeTitle(s string) string {
	s = strings.TrimSpace(s)
	if i := strings.IndexAny(s, "\r\n"); i >= 0 {
		s = s[:i]
	}
	s = strings.Trim(s, " \t\"'“”『』「」【】*#")
	s = strings.TrimSpace(s)
	// Clamp to a sane length (count runes, not bytes).
	r := []rune(s)
	if len(r) > 40 {
		s = string(r[:40])
	}
	return s
}

// extractMessageText pulls the text out of an AIMessage.Content JSON blob.
func extractMessageText(content string) string {
	var parts []provider.ContentPart
	if err := json.Unmarshal([]byte(content), &parts); err != nil {
		return content
	}
	var sb strings.Builder
	for _, p := range parts {
		if p.Type == "text" || p.Type == "" {
			sb.WriteString(p.Text)
		}
	}
	return sb.String()
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

func makeToolCtx(ctx context.Context, conv *aimodel.AIConversation, _ *aimodel.AIAgent) tools.ToolCtx {
	return tools.ToolCtx{
		UserID:   conv.UserID,
		Username: resolveUsername(ctx, conv.UserID),
		ConvID:   conv.ID,
	}
}
