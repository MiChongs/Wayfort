// Package provider abstracts the wire-protocol differences between LLM
// providers (OpenAI, Anthropic, Gemini, OpenAI-compatible gateways). The
// Provider interface deliberately speaks streaming events so that callers
// (the runner + SSE pump) can forward output without buffering an entire turn.
package provider

import (
	"context"
	"errors"

	aimodel "github.com/michongs/jumpserver-anonymous/internal/ai/model"
)

type Kind = aimodel.ProviderKind

// Re-export the kind constants for callers that don't want to import the
// model package just to compare strings.
const (
	KindOpenAI       = aimodel.ProviderOpenAI
	KindAnthropic    = aimodel.ProviderAnthropic
	KindOpenAICompat = aimodel.ProviderOpenAICompat
	KindGemini       = aimodel.ProviderGemini
)

// MessageRole mirrors the strings used by major providers.
type MessageRole string

const (
	RoleSystem    MessageRole = "system"
	RoleUser      MessageRole = "user"
	RoleAssistant MessageRole = "assistant"
	RoleTool      MessageRole = "tool"
)

// ContentPart is one segment of a (potentially multi-part) message body.
type ContentPart struct {
	Type     string `json:"type"` // "text" | "image_url" | "tool_use" | "tool_result"
	Text     string `json:"text,omitempty"`
	ImageURL string `json:"image_url,omitempty"`
}

// ToolCall is what an assistant message hands back to invoke a tool.
type ToolCall struct {
	ID        string `json:"id"`
	Name      string `json:"name"`
	Arguments string `json:"arguments"` // raw JSON string
}

// Message is one entry in the chat history sent to the provider.
type Message struct {
	Role       MessageRole   `json:"role"`
	Content    []ContentPart `json:"content,omitempty"`
	ToolCallID string        `json:"tool_call_id,omitempty"`
	ToolCalls  []ToolCall    `json:"tool_calls,omitempty"`
	Name       string        `json:"name,omitempty"`
}

// ToolSchema is what we hand the LLM so it knows how to call a tool. The
// JSONSchema is provider-agnostic; each Provider implementation re-wraps it
// into the upstream format (OpenAI "function" / Anthropic "input_schema" /
// Gemini "FunctionDeclaration").
type ToolSchema struct {
	Name        string `json:"name"`
	Description string `json:"description"`
	JSONSchema  []byte `json:"json_schema"`
}

// Request is one chat completion call.
type Request struct {
	Model       string
	System      string
	Messages    []Message
	Tools       []ToolSchema
	Temperature *float64
	TopP        *float64
	MaxTokens   int
	// ThinkingBudget, when > 0, enables the provider's extended-thinking /
	// reasoning mode with that many tokens of thinking budget (Anthropic
	// Extended Thinking). Providers that don't support it ignore the field.
	ThinkingBudget int
	Metadata       map[string]string
}

// EventType is the discriminator for the stream events Provider emits.
type EventType string

const (
	EvtMessageStart   EventType = "message_start"
	EvtTextDelta      EventType = "text_delta"
	EvtToolCallStart  EventType = "tool_call_start"
	EvtToolArgsDelta  EventType = "tool_args_delta"
	EvtToolCallEnd    EventType = "tool_call_end"
	EvtUsage          EventType = "usage"
	EvtMessageEnd     EventType = "message_end"
	EvtError          EventType = "error"
	EvtReasoningStart EventType = "reasoning_start"
	EvtReasoningDelta EventType = "reasoning_delta"
	EvtReasoningEnd   EventType = "reasoning_end"
)

// Event is the streaming payload yielded on the chan returned by Stream.
type Event struct {
	Type         EventType
	Text         string
	ToolCallID   string
	ToolName     string
	ToolArgs     string // accumulated argument JSON (for tool_call_end)
	InputTokens  uint32
	OutputTokens uint32
	FinishReason string
	Err          error
}

// ModelInfo is returned by ListModels for UI display + capability gating.
type ModelInfo struct {
	ID            string `json:"id"`
	Label         string `json:"label,omitempty"`
	ContextWindow int    `json:"context_window,omitempty"`
	MaxOutput     int    `json:"max_output,omitempty"`
	Vision        bool   `json:"vision,omitempty"`
	Tools         bool   `json:"tools,omitempty"`
}

// Provider is the common surface. Implementations live alongside this file.
type Provider interface {
	Name() string
	Kind() Kind
	Stream(ctx context.Context, req Request) (<-chan Event, error)
	ListModels(ctx context.Context) ([]ModelInfo, error)
	Ping(ctx context.Context) error
}

// ErrUnsupported is returned when a Provider doesn't implement an optional API.
var ErrUnsupported = errors.New("unsupported by this provider")
