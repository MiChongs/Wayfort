package model

import "time"

// AssetGroup is a tree-shaped collection of nodes. Path uses materialised form
// ("3/12/45") so subtree lookups are a single LIKE 'path%' scan.
type AssetGroup struct {
	ID          uint64    `gorm:"primaryKey" json:"id"`
	Name        string    `gorm:"size:128;not null" json:"name"`
	ParentID    *uint64   `gorm:"index" json:"parent_id,omitempty"`
	Path        string    `gorm:"size:255;index" json:"path"`
	Description string    `gorm:"size:255" json:"description"`
	CreatedAt   time.Time `json:"created_at"`
	UpdatedAt   time.Time `json:"updated_at"`
}

func (AssetGroup) TableName() string { return "asset_groups" }

type AssetGroupNode struct {
	GroupID uint64 `gorm:"primaryKey" json:"group_id"`
	NodeID  uint64 `gorm:"primaryKey" json:"node_id"`
}

func (AssetGroupNode) TableName() string { return "asset_group_nodes" }

type AssetTag struct {
	ID        uint64    `gorm:"primaryKey" json:"id"`
	Name      string    `gorm:"size:64;uniqueIndex;not null" json:"name"`
	Color     string    `gorm:"size:16" json:"color"`
	CreatedAt time.Time `json:"created_at"`
}

func (AssetTag) TableName() string { return "asset_tags" }

type NodeTag struct {
	NodeID uint64 `gorm:"primaryKey" json:"node_id"`
	TagID  uint64 `gorm:"primaryKey" json:"tag_id"`
}

func (NodeTag) TableName() string { return "node_tags" }

// GranteeType / SubjectType enumerate who and what an AssetGrant binds.
type GranteeType string
type SubjectType string

const (
	GranteeUser       GranteeType = "user"
	GranteeRole       GranteeType = "role"
	GranteeGroup      GranteeType = "group"
	GranteeDepartment GranteeType = "department"

	SubjectNode       SubjectType = "node"
	SubjectAssetGroup SubjectType = "group"
	SubjectTag        SubjectType = "tag"
	SubjectAll        SubjectType = "all"
)

// AssetGrant is the core authorisation record. Actions is a comma-separated set
// of action codes (connect/sftp_read/sftp_write/port_forward/upload/download/exec).
type AssetGrant struct {
	ID          uint64      `gorm:"primaryKey" json:"id"`
	GranteeType GranteeType `gorm:"size:16;index:idx_grantee" json:"grantee_type"`
	GranteeID   uint64      `gorm:"index:idx_grantee" json:"grantee_id"`
	SubjectType SubjectType `gorm:"size:16;index:idx_subject" json:"subject_type"`
	SubjectID   uint64      `gorm:"index:idx_subject" json:"subject_id"`
	Actions     string      `gorm:"size:255" json:"actions"`
	ValidFrom   *time.Time  `json:"valid_from,omitempty"`
	ValidTo     *time.Time  `json:"valid_to,omitempty"`
	Source      string      `gorm:"size:32" json:"source"`
	CreatedBy   uint64      `json:"created_by"`
	CreatedAt   time.Time   `json:"created_at"`
}

func (AssetGrant) TableName() string { return "asset_grants" }

// NodeFavorite lets a user pin frequently-used nodes.
type NodeFavorite struct {
	UserID    uint64    `gorm:"primaryKey" json:"user_id"`
	NodeID    uint64    `gorm:"primaryKey" json:"node_id"`
	CreatedAt time.Time `json:"created_at"`
}

func (NodeFavorite) TableName() string { return "node_favorites" }

// NodeRecent tracks the last time a user opened a session on a node.
type NodeRecent struct {
	UserID     uint64    `gorm:"primaryKey" json:"user_id"`
	NodeID     uint64    `gorm:"primaryKey" json:"node_id"`
	LastUsedAt time.Time `gorm:"index" json:"last_used_at"`
	Hits       uint64    `json:"hits"`
}

func (NodeRecent) TableName() string { return "node_recent" }
