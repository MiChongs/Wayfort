package model

import "time"

type ConversationStatus string

const (
	ConvStatusActive   ConversationStatus = "active"
	ConvStatusRunning  ConversationStatus = "running"
	ConvStatusIdle     ConversationStatus = "idle"
	ConvStatusArchived ConversationStatus = "archived"
)

// AIConversation is one chat session bound to a user, agent and provider.
type AIConversation struct {
	ID                 string             `gorm:"primaryKey;size:64" json:"id"`
	UserID             uint64             `gorm:"index;not null" json:"user_id"`
	AgentID            uint64             `gorm:"index;not null" json:"agent_id"`
	Title              string             `gorm:"size:255" json:"title"`
	ProviderID         uint64             `json:"provider_id"`
	Model              string             `gorm:"size:128" json:"model"`
	PermissionMode     PermissionMode     `gorm:"size:16" json:"permission_mode"`
	TotalInputTokens   uint64             `json:"total_input_tokens"`
	TotalOutputTokens  uint64             `json:"total_output_tokens"`
	// Cumulative prompt-cache tokens across the conversation. Cache reads are
	// billed cheaper than fresh input; surfaced in the usage/cost panels.
	TotalCacheReadTokens  uint64          `json:"total_cache_read_tokens"`
	TotalCacheWriteTokens uint64          `json:"total_cache_write_tokens"`
	TotalCostMicros    uint64             `json:"total_cost_micros"`
	MessageCount       int                `json:"message_count"`
	Status             ConversationStatus `gorm:"size:16;index" json:"status"`
	Archived           bool               `gorm:"index" json:"archived"`
	Pinned             bool               `gorm:"index;default:false" json:"pinned"`
	// Optional per-conversation overrides; NULL falls back to the agent's default.
	Temperature        *float64           `gorm:"column:temperature" json:"temperature,omitempty"`
	TopP               *float64           `gorm:"column:top_p" json:"top_p,omitempty"`
	MaxTokens          *int               `gorm:"column:max_tokens" json:"max_tokens,omitempty"`
	// ThinkingBudget enables provider extended-thinking with this many tokens
	// of reasoning budget (NULL / 0 = off). Surfaced as the "深度思考" toggle.
	ThinkingBudget     *int               `gorm:"column:thinking_budget" json:"thinking_budget,omitempty"`
	ParentConversation *string            `gorm:"size:64;index" json:"parent_conversation,omitempty"`
	// ActiveLeafMessageID is the tip of the currently-displayed message branch.
	// When NULL the conversation is linear (history = ListByConv). When set, the
	// model context + UI follow the path from this leaf up through ParentID, so
	// editing a user message can fork a branch without destroying the old one.
	ActiveLeafMessageID *uint64           `gorm:"index" json:"active_leaf_message_id,omitempty"`
	// Rolling context summary: RunningSummary condenses every turn whose id is
	// <= SummarizedUpToMessageID, so overflow handling never re-summarizes from
	// scratch. Empty when the "summarize" strategy hasn't fired yet.
	RunningSummary          string       `gorm:"type:text" json:"running_summary,omitempty"`
	SummarizedUpToMessageID uint64       `gorm:"index" json:"summarized_up_to_message_id,omitempty"`
	SummaryTokenEstimate    int          `json:"summary_token_estimate,omitempty"`
	CreatedAt          time.Time          `json:"created_at"`
	UpdatedAt          time.Time          `json:"updated_at"`
}

func (AIConversation) TableName() string { return "ai_conversations" }
