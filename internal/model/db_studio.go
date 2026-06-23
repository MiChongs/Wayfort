package model

import "time"

// Db Studio Phase 1.5 — persistent GORM models for the SQL editor, data
// viewer, and ER-diagram subsystems. Five tables back, respectively:
//
//   - saved_queries  — server-side SQL snippets a user/team can recall
//   - pinned_results — frozen query + Arrow-IPC result snapshots
//   - query_history  — auditable log of every executed SQL statement
//   - view_profiles  — named filter/sort/column combos per table
//   - er_models      — Phase 1F entity-relationship diagrams
//
// All identifier columns are uint64 to match the repository-wide convention
// (Node.ID, OwnerID, UserID, …). Time columns use time.Time with GORM's
// autoCreateTime/autoUpdateTime tags mirroring the brief's SQL TIMESTAMP
// defaults. LONGTEXT → gorm:"type:longtext", LONGBLOB → []byte with
// gorm:"type:longblob".

// SavedQuery is a server-side SQL snippet a user (or team) can recall.
type SavedQuery struct {
	ID          uint64    `gorm:"primaryKey" json:"id"`
	OwnerID     uint64    `gorm:"index;not null" json:"owner_id"`
	Name        string    `gorm:"size:255;not null" json:"name"`
	FolderPath  string    `gorm:"size:512;index" json:"folder_path"`
	SQL         string    `gorm:"type:longtext;not null" json:"sql"`
	ParamsJSON  string    `gorm:"type:longtext" json:"params_json,omitempty"`
	SharedScope string    `gorm:"size:16;not null" json:"shared_scope"` // user|team|node
	UpdatedAt   time.Time `gorm:"autoUpdateTime" json:"updated_at"`
}

// TableName pins the Db Studio saved-query table.
func (SavedQuery) TableName() string { return "saved_queries" }

// PinnedResult freezes a query plus its result snapshot in Arrow IPC form.
type PinnedResult struct {
	ID            uint64    `gorm:"primaryKey" json:"id"`
	OwnerID       uint64    `gorm:"index;not null" json:"owner_id"`
	NodeID        uint64    `gorm:"index;not null" json:"node_id"`
	SQL           string    `gorm:"type:longtext;not null" json:"sql"`
	ParamsJSON    string    `gorm:"type:longtext" json:"params_json,omitempty"`
	ExecutedAt    time.Time `gorm:"index;not null" json:"executed_at"`
	RowCount      int64     `json:"row_count"`
	SnapshotArrow []byte    `gorm:"type:longblob" json:"snapshot_arrow,omitempty"`
	TTL           time.Time `json:"ttl"`
}

// TableName pins the Db Studio pinned-result table.
func (PinnedResult) TableName() string { return "pinned_results" }

// QueryHistory keeps an auditable log of every executed SQL statement.
type QueryHistory struct {
	ID         uint64    `gorm:"primaryKey" json:"id"`
	OwnerID    uint64    `gorm:"index;not null" json:"owner_id"`
	NodeID     uint64    `gorm:"index;not null" json:"node_id"`
	SQL        string    `gorm:"type:longtext;not null" json:"sql"`
	ParamsJSON string    `gorm:"type:longtext" json:"params_json,omitempty"`
	ExecutedAt time.Time `gorm:"index;not null" json:"executed_at"`
	DurationMs int32     `json:"duration_ms"`
	// RowCount mirrors the brief's nullable BIGINT — a pointer so a query that
	// errored before producing rows is distinguishable from one that returned 0.
	RowCount  *int64 `json:"row_count,omitempty"`
	Status    string `gorm:"size:16;not null" json:"status"` // ok|error
	ErrorText string `gorm:"type:text" json:"error_text,omitempty"`
}

// TableName pins the Db Studio query-history table.
func (QueryHistory) TableName() string { return "query_history" }

// ViewProfile stores a named filter+sort+columns combo for a single table.
type ViewProfile struct {
	ID          uint64    `gorm:"primaryKey" json:"id"`
	OwnerID     uint64    `gorm:"index;not null" json:"owner_id"`
	NodeID      uint64    `gorm:"index;not null" json:"node_id"`
	TableFQN    string    `gorm:"size:512;index;not null" json:"table_fqn"`
	Name        string    `gorm:"size:255;not null" json:"name"`
	FilterJSON  string    `gorm:"type:longtext" json:"filter_json,omitempty"`
	SortJSON    string    `gorm:"type:longtext" json:"sort_json,omitempty"`
	ColumnsJSON string    `gorm:"type:longtext" json:"columns_json,omitempty"`
	IsDefault   bool      `json:"is_default"`
	UpdatedAt   time.Time `gorm:"autoUpdateTime" json:"updated_at"`
}

// TableName pins the Db Studio view-profile table.
func (ViewProfile) TableName() string { return "view_profiles" }

// ERModel persists a Phase 1F entity-relationship diagram.
type ERModel struct {
	ID        uint64    `gorm:"primaryKey" json:"id"`
	OwnerID   uint64    `gorm:"index;not null" json:"owner_id"`
	Name      string    `gorm:"size:255;not null" json:"name"`
	Dialect   string    `gorm:"size:32;not null" json:"dialect"`
	ModelJSON string    `gorm:"type:longtext;not null" json:"model_json"`
	CreatedAt time.Time `gorm:"autoCreateTime" json:"created_at"`
	UpdatedAt time.Time `gorm:"autoUpdateTime" json:"updated_at"`
}

// TableName pins the Db Studio ER-model table.
func (ERModel) TableName() string { return "er_models" }
