package model

import "time"

// TaskStatus is the lifecycle of one agent plan item.
type TaskStatus string

const (
	TaskPending TaskStatus = "pending"
	TaskActive  TaskStatus = "active"
	TaskDone    TaskStatus = "done"
	TaskSkipped TaskStatus = "skipped"
	TaskFailed  TaskStatus = "failed"
)

// ValidTaskStatus reports whether s is a recognized status (defaults are coerced
// to pending by the caller).
func ValidTaskStatus(s TaskStatus) bool {
	switch s {
	case TaskPending, TaskActive, TaskDone, TaskSkipped, TaskFailed:
		return true
	}
	return false
}

// AITask is one item in a conversation's live execution plan. The long-horizon
// agent maintains the plan via the runner-intercepted `update_plan` tool
// (full-array replace, TodoWrite-style), and the frontend renders it as a live
// TODO panel. One plan (ordered set of tasks) per conversation.
type AITask struct {
	ID             uint64     `gorm:"primaryKey" json:"id"`
	ConversationID string     `gorm:"size:64;index;not null" json:"conversation_id"`
	Ordinal        int        `gorm:"not null;index" json:"ordinal"`
	Title          string     `gorm:"size:512;not null" json:"title"`
	Status         TaskStatus `gorm:"size:16;index;not null" json:"status"`
	Detail         string     `gorm:"type:text" json:"detail,omitempty"`
	CreatedAt      time.Time  `json:"created_at"`
	UpdatedAt      time.Time  `json:"updated_at"`
}

func (AITask) TableName() string { return "ai_tasks" }
