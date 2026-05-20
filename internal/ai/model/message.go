package model

import "time"

type MessageRole string

const (
	RoleSystem    MessageRole = "system"
	RoleUser      MessageRole = "user"
	RoleAssistant MessageRole = "assistant"
	RoleTool      MessageRole = "tool"
)

// AIMessage is one turn in a conversation. Content is JSON so we can carry
// OpenAI-style multi-part / Anthropic-style content blocks without losing fidelity.
type AIMessage struct {
	ID             uint64      `gorm:"primaryKey" json:"id"`
	ConversationID string      `gorm:"size:64;index;not null" json:"conversation_id"`
	ParentID       *uint64     `gorm:"index" json:"parent_id,omitempty"`
	Role           MessageRole `gorm:"size:16;not null" json:"role"`
	Content        string      `gorm:"type:text" json:"content"`
	ToolCallID     string      `gorm:"size:64" json:"tool_call_id,omitempty"`
	ToolCalls      string      `gorm:"type:text" json:"tool_calls,omitempty"`
	InputTokens    uint32      `json:"input_tokens"`
	OutputTokens   uint32      `json:"output_tokens"`
	FinishReason   string      `gorm:"size:32" json:"finish_reason,omitempty"`
	CreatedAt      time.Time   `gorm:"index" json:"created_at"`
}

func (AIMessage) TableName() string { return "ai_messages" }
