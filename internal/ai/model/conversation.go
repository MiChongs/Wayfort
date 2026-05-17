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
	TotalCostMicros    uint64             `json:"total_cost_micros"`
	MessageCount       int                `json:"message_count"`
	Status             ConversationStatus `gorm:"size:16;index" json:"status"`
	Archived           bool               `gorm:"index" json:"archived"`
	Pinned             bool               `gorm:"index;default:false" json:"pinned"`
	// Optional per-conversation overrides; NULL falls back to the agent's default.
	Temperature        *float64           `gorm:"column:temperature" json:"temperature,omitempty"`
	TopP               *float64           `gorm:"column:top_p" json:"top_p,omitempty"`
	MaxTokens          *int               `gorm:"column:max_tokens" json:"max_tokens,omitempty"`
	ParentConversation *string            `gorm:"size:64;index" json:"parent_conversation,omitempty"`
	CreatedAt          time.Time          `json:"created_at"`
	UpdatedAt          time.Time          `json:"updated_at"`
}

func (AIConversation) TableName() string { return "ai_conversations" }
