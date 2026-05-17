package model

import "time"

type InvocationStatus string

const (
	InvStatusPending   InvocationStatus = "pending"
	InvStatusApproved  InvocationStatus = "approved"
	InvStatusRejected  InvocationStatus = "rejected"
	InvStatusRunning   InvocationStatus = "running"
	InvStatusSucceeded InvocationStatus = "succeeded"
	InvStatusFailed    InvocationStatus = "failed"
	InvStatusDryRun    InvocationStatus = "dry_run"
)

// AIToolInvocation records each tool call attempted by an agent — both the
// arguments it requested and the eventual outcome. Pending rows are what the
// frontend polls/streams while awaiting user approval.
type AIToolInvocation struct {
	ID              string           `gorm:"primaryKey;size:64" json:"id"`
	ConversationID  string           `gorm:"size:64;index;not null" json:"conversation_id"`
	MessageID       uint64           `gorm:"index" json:"message_id"`
	ToolName        string           `gorm:"size:64;index" json:"tool_name"`
	InputJSON       string           `gorm:"type:text" json:"input"`
	PermissionMode  PermissionMode   `gorm:"size:16" json:"permission_mode"`
	Status          InvocationStatus `gorm:"size:16;index" json:"status"`
	ApprovedBy      *uint64          `json:"approved_by,omitempty"`
	ApprovedAt      *time.Time       `json:"approved_at,omitempty"`
	OutputText      string           `gorm:"type:longtext" json:"output,omitempty"`
	OutputTruncated bool             `json:"output_truncated"`
	DurationMs      uint32           `json:"duration_ms"`
	ErrorMessage    string           `gorm:"size:1024" json:"error,omitempty"`
	CreatedAt       time.Time        `gorm:"index" json:"created_at"`
	CompletedAt     *time.Time       `json:"completed_at,omitempty"`
}

func (AIToolInvocation) TableName() string { return "ai_tool_invocations" }
