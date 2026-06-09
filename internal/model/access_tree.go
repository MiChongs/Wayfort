package model

import "time"

// AccessFolder is a folder in an authorisation OBJECT's asset tree.
//
// The tree is owned by a grantee (OwnerType ∈ user / group / department) and IS
// that grantee's authorisation: placing assets into it grants access, and the
// members of a group / department inherit the group / department's tree (the
// Resolver expands the user into their grantees exactly like AssetGrant). There
// is no separate "create catalog then assign" step — you edit an object's tree
// and that object is authorised.
//
// Path is the materialised form ("12/45", folder IDs) scoped to the owner so
// subtree lookups are a single LIKE scan. Actions / validity are OPTIONAL
// defaults inherited by the subtree: empty Actions = inherit the parent chain
// (root default = "connect"); nil ValidFrom/ValidTo = inherit the parent chain.
type AccessFolder struct {
	ID        uint64      `gorm:"primaryKey" json:"id"`
	OwnerType GranteeType `gorm:"size:16;index:idx_af_owner" json:"owner_type"`
	OwnerID   uint64      `gorm:"index:idx_af_owner" json:"owner_id"`
	Name      string      `gorm:"size:128;not null" json:"name"`
	ParentID  *uint64     `gorm:"index" json:"parent_id,omitempty"`
	Path      string      `gorm:"size:255;index" json:"path"`
	Icon      string      `gorm:"size:48" json:"icon"`
	SortOrder int         `gorm:"default:0" json:"sort_order"`
	Actions   string      `gorm:"size:255" json:"actions"` // csv, "" = inherit parent
	ValidFrom *time.Time  `json:"valid_from,omitempty"`
	ValidTo   *time.Time  `json:"valid_to,omitempty"`
	CreatedAt time.Time   `json:"created_at"`
	UpdatedAt time.Time   `json:"updated_at"`
}

func (AccessFolder) TableName() string { return "access_folders" }

// AccessItem places a node into a folder of an owner's tree, optionally with its
// own permission / validity override. Empty Actions = inherit the folder chain;
// nil ValidFrom/ValidTo = inherit the folder chain. The same node may appear in
// multiple folders (items are intentionally non-unique across folders).
type AccessItem struct {
	ID        uint64      `gorm:"primaryKey" json:"id"`
	OwnerType GranteeType `gorm:"size:16;index:idx_ai_owner" json:"owner_type"`
	OwnerID   uint64      `gorm:"index:idx_ai_owner" json:"owner_id"`
	FolderID  uint64      `gorm:"index" json:"folder_id"`
	NodeID    uint64      `gorm:"index" json:"node_id"`
	Actions   string      `gorm:"size:255" json:"actions"` // csv, "" = inherit folder
	ValidFrom *time.Time  `json:"valid_from,omitempty"`
	ValidTo   *time.Time  `json:"valid_to,omitempty"`
	SortOrder int         `gorm:"default:0" json:"sort_order"`
	CreatedAt time.Time   `json:"created_at"`
}

func (AccessItem) TableName() string { return "access_items" }
