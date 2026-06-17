// Package provider abstracts the wire-protocol differences between LLM
// providers (OpenAI, Anthropic, Gemini, OpenAI-compatible gateways). The
// Provider interface deliberately speaks streaming events so that callers
// (the runner + SSE pump) can forward output without buffering an entire turn.
package provider

import (
	"context"
	"errors"

	aimodel "github.com/michongs/wayfort/internal/ai/model"
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

// EmbedRequest is one embedding call. Inputs are embedded in a single batch
// request; the provider returns one vector per input in the same order.
type EmbedRequest struct {
	Model      string
	Inputs     []string
	Dimensions int // optional; 0 = model default (only honored by models that support it)
}

// EmbedResponse carries the embedding vectors plus the resolved dimension so the
// caller can freeze it on a knowledge base. InputTokens is reported where the
// provider surfaces usage (used for rate-limit accounting); zero otherwise.
type EmbedResponse struct {
	Vectors     [][]float32
	Model       string
	Dimension   int
	InputTokens uint32
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
	// CacheReadTokens / CacheWriteTokens report prompt-cache hits/writes when the
	// provider surfaces them (Anthropic cache_read/creation_input_tokens, OpenAI
	// prompt_tokens_details.cached_tokens, Gemini cached_content_token_count).
	// Cache reads are billed cheaper than fresh input; the runner uses these for
	// accurate cost accounting. Zero when the provider doesn't report caching.
	CacheReadTokens  uint32
	CacheWriteTokens uint32
	FinishReason     string
	Err              error
}

// ModelPricing is the per-model list price (USD per 1M tokens) curated on a
// provider row. When present it overrides the runner's static price table so
// operators can pin accurate (or contract) rates per model. Zero fields fall
// back to the static estimate.
type ModelPricing struct {
	InPerMTok         float64 `json:"in_per_mtok,omitempty"`
	OutPerMTok        float64 `json:"out_per_mtok,omitempty"`
	CacheReadPerMTok  float64 `json:"cache_read_per_mtok,omitempty"`
	CacheWritePerMTok float64 `json:"cache_write_per_mtok,omitempty"`
}

// IsZero reports whether no price was set (so callers fall back to the estimate).
func (p ModelPricing) IsZero() bool {
	return p.InPerMTok == 0 && p.OutPerMTok == 0 && p.CacheReadPerMTok == 0 && p.CacheWritePerMTok == 0
}

// ModelInfo is returned by ListModels for UI display + capability gating, and is
// also the persisted shape of a provider's curated model list (the Models JSON
// column). Newer fields are omitempty so rows written by older code unmarshal
// cleanly with zero values.
type ModelInfo struct {
	ID            string        `json:"id"`
	Label         string        `json:"label,omitempty"`
	ContextWindow int           `json:"context_window,omitempty"`
	MaxOutput     int           `json:"max_output,omitempty"`
	Vision        bool          `json:"vision,omitempty"`
	Tools         bool          `json:"tools,omitempty"`
	Reasoning     bool          `json:"reasoning,omitempty"`
	Caching       bool          `json:"caching,omitempty"`
	// Embedding marks a text-embedding model. These are filtered OUT of the chat
	// model pickers (they can't chat) but surfaced in the embedding-model picker
	// for knowledge bases / memory.
	Embedding bool          `json:"embedding,omitempty"`
	Pricing   *ModelPricing `json:"pricing,omitempty"`
}

// Provider is the common surface. Implementations live alongside this file.
type Provider interface {
	Name() string
	Kind() Kind
	Stream(ctx context.Context, req Request) (<-chan Event, error)
	// Embed returns one vector per input. Providers without an embeddings API
	// (e.g. Anthropic) return ErrUnsupported.
	Embed(ctx context.Context, req EmbedRequest) (EmbedResponse, error)
	ListModels(ctx context.Context) ([]ModelInfo, error)
	Ping(ctx context.Context) error
	// CuratedModels returns the operator-saved model list (capabilities + pricing)
	// from the provider row, or nil when none was configured. Distinct from
	// ListModels, which may hit the network for live discovery.
	CuratedModels() []ModelInfo
}

// ErrUnsupported is returned when a Provider doesn't implement an optional API.
var ErrUnsupported = errors.New("unsupported by this provider")
