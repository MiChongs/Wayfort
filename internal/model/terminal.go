package model

import "time"

// Snippet — Phase 11 user-owned reusable command template. The body may
// contain {{var}} placeholders; the API exposes resolution + variable
// extraction so the UI can prompt for missing values before insertion.
type Snippet struct {
	ID          uint64    `gorm:"primaryKey" json:"id"`
	UserID      uint64    `gorm:"index;not null" json:"user_id"`
	Name        string    `gorm:"size:128;not null" json:"name"`
	Description string    `gorm:"size:512" json:"description,omitempty"`
	Body        string    `gorm:"type:text;not null" json:"body"`
	// Tags is a comma-separated label list used for filtering / "folder"
	// grouping in the UI. e.g. "ops,k8s,prod".
	Tags string `gorm:"size:256" json:"tags,omitempty"`
	// Pinned snippets float to the top of the sidebar.
	Pinned bool `gorm:"default:false" json:"pinned"`
	// UsageCount lets the UI surface "most used" alongside "recent".
	UsageCount uint64    `gorm:"default:0" json:"usage_count"`
	LastUsedAt *time.Time `json:"last_used_at,omitempty"`
	CreatedAt  time.Time  `json:"created_at"`
	UpdatedAt  time.Time  `json:"updated_at"`
}

func (Snippet) TableName() string { return "snippets" }

// CommandHistory — opt-in capture of commands executed via WebSSH. Only
// stored when the user has terminal_profile.history_enabled = true.
type CommandHistory struct {
	ID        uint64    `gorm:"primaryKey" json:"id"`
	UserID    uint64    `gorm:"index;not null" json:"user_id"`
	NodeID    *uint64   `gorm:"index" json:"node_id,omitempty"`
	SessionID string    `gorm:"size:64;index" json:"session_id,omitempty"`
	Command   string    `gorm:"type:text;not null" json:"command"`
	// ExitCode and DurationMs are best-effort; not all command runs surface
	// completion (long-running ones may close the session). Zero is "unknown".
	ExitCode   int    `gorm:"default:0" json:"exit_code"`
	DurationMs int64  `gorm:"default:0" json:"duration_ms"`
	WorkingDir string `gorm:"size:1024" json:"working_dir,omitempty"`
	CreatedAt  time.Time `gorm:"index" json:"created_at"`
}

func (CommandHistory) TableName() string { return "command_history" }

// TerminalProfile — server-synced user preferences. The frontend still
// caches a copy in localStorage for instant first paint; the profile is the
// canonical truth for cross-device sync.
type TerminalProfile struct {
	UserID uint64 `gorm:"primaryKey" json:"user_id"`
	// Body is an opaque JSON blob keyed by the same shape as
	// TerminalSettings on the frontend. We don't enforce schema here so
	// adding new fields doesn't require a migration.
	Body string `gorm:"type:text" json:"body"`
	// HistoryEnabled gates CommandHistory capture. Defaults to false so
	// existing installs don't surprise their users.
	HistoryEnabled bool      `gorm:"default:false" json:"history_enabled"`
	UpdatedAt      time.Time `json:"updated_at"`
}

func (TerminalProfile) TableName() string { return "terminal_profiles" }
