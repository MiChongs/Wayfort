package model

import "time"

type AgentScope string

const (
	AgentScopeGlobal   AgentScope = "global"
	AgentScopePersonal AgentScope = "personal"
)

type PermissionMode string

const (
	PermModePlan   PermissionMode = "plan"
	PermModeNormal PermissionMode = "normal"
	PermModeBypass PermissionMode = "bypass"
)

type ContextStrategy string

const (
	CtxStrategyNone           ContextStrategy = "none"
	CtxStrategyTruncateOldest ContextStrategy = "truncate_oldest"
	CtxStrategySummarize      ContextStrategy = "summarize"
)

// AIAgent is one named persona: system prompt + allowed tools + default model.
// Global agents are visible to everyone; personal agents only to their owner.
type AIAgent struct {
	ID                uint64          `gorm:"primaryKey" json:"id"`
	Name              string          `gorm:"size:128;index;not null" json:"name"`
	Description       string          `gorm:"size:512" json:"description"`
	// Icon is an optional unified icon token for the agent avatar
	// ("lucide:bot", "simple:openai", "emoji:🤖"). Empty == initials avatar.
	Icon              string          `gorm:"size:48" json:"icon,omitempty"`
	Scope             AgentScope      `gorm:"size:16;index;not null" json:"scope"`
	OwnerID           *uint64         `gorm:"index" json:"owner_id,omitempty"`
	SystemPrompt      string          `gorm:"type:text" json:"system_prompt"`
	DefaultProviderID *uint64         `json:"default_provider_id,omitempty"`
	DefaultModel      string          `gorm:"size:128" json:"default_model"`
	AllowedTools      string          `gorm:"type:text" json:"allowed_tools"` // JSON array
	PermissionMode    PermissionMode  `gorm:"size:16;default:normal" json:"permission_mode"`
	MaxIterations     int             `gorm:"default:20" json:"max_iterations"`
	Temperature       float64         `json:"temperature"`
	TopP              float64         `json:"top_p"`
	ContextStrategy   ContextStrategy `gorm:"size:24;default:truncate_oldest" json:"context_strategy"`
	IsSubAgent        bool            `gorm:"default:false" json:"is_sub_agent"`
	InvocationHint    string          `gorm:"size:512" json:"invocation_hint,omitempty"`
	Tags              string          `gorm:"size:512" json:"tags,omitempty"`
	// KnowledgeBaseIDs is a JSON array of knowledge-base ids this agent may search
	// (encoded like AllowedTools). Empty / "[]" = no RAG. Gates knowledge_search.
	KnowledgeBaseIDs string `gorm:"type:text" json:"knowledge_base_ids,omitempty"`
	// MemoryEnabled turns on cross-session long-term memory recall + the remember
	// tool for this agent.
	MemoryEnabled bool      `gorm:"default:false" json:"memory_enabled"`
	Enabled       bool      `gorm:"default:true" json:"enabled"`
	CreatedAt         time.Time       `json:"created_at"`
	UpdatedAt         time.Time       `json:"updated_at"`
}

func (AIAgent) TableName() string { return "ai_agents" }
