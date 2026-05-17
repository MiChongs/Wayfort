package model

import "time"

// UserGroup is a flat (non-hierarchical) bag of users used by asset grants.
type UserGroup struct {
	ID          uint64    `gorm:"primaryKey" json:"id"`
	Name        string    `gorm:"size:128;uniqueIndex;not null" json:"name"`
	Description string    `gorm:"size:255" json:"description"`
	CreatedAt   time.Time `json:"created_at"`
	UpdatedAt   time.Time `json:"updated_at"`
}

func (UserGroup) TableName() string { return "user_groups" }

type UserGroupMember struct {
	GroupID  uint64    `gorm:"primaryKey" json:"group_id"`
	UserID   uint64    `gorm:"primaryKey" json:"user_id"`
	JoinedAt time.Time `json:"joined_at"`
}

func (UserGroupMember) TableName() string { return "user_group_members" }
