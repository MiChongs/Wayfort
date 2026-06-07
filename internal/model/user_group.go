package model

import "time"

// UserGroup is a tree node (mirrors Department / AssetGroup). Path is
// materialised ("1/4/9") so subtree queries use a single LIKE prefix scan and
// ancestor lookups (for grant inheritance) split the path string. A child group
// inherits the asset grants of its ancestors.
type UserGroup struct {
	ID          uint64    `gorm:"primaryKey" json:"id"`
	Name        string    `gorm:"size:128;not null" json:"name"`
	Description string    `gorm:"size:255" json:"description"`
	Icon        string    `gorm:"size:64" json:"icon,omitempty"`
	ParentID    *uint64   `gorm:"index" json:"parent_id,omitempty"`
	Path        string    `gorm:"size:255;index" json:"path"`
	OrderIdx    int       `gorm:"default:0" json:"order_idx"`
	CreatedAt   time.Time `json:"created_at"`
	UpdatedAt   time.Time `json:"updated_at"`

	// MemberIDs is populated by the list handler (batched), not a column.
	MemberIDs []uint64 `gorm:"-" json:"member_ids,omitempty"`
}

func (UserGroup) TableName() string { return "user_groups" }

type UserGroupMember struct {
	GroupID  uint64    `gorm:"primaryKey" json:"group_id"`
	UserID   uint64    `gorm:"primaryKey" json:"user_id"`
	JoinedAt time.Time `json:"joined_at"`
}

func (UserGroupMember) TableName() string { return "user_group_members" }
