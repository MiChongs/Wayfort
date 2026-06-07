package model

import "time"

// Department is a tree node. Path is materialised ("1/4/9") so subtree queries
// can be implemented with a single LIKE prefix scan, and ancestor lookups
// (used for grant inheritance) can be done by splitting the path string.
type Department struct {
	ID          uint64    `gorm:"primaryKey" json:"id"`
	Name        string    `gorm:"size:128;not null" json:"name"`
	Description string    `gorm:"size:255" json:"description"`
	Icon        string    `gorm:"size:64" json:"icon,omitempty"`
	ParentID    *uint64   `gorm:"index" json:"parent_id,omitempty"`
	Path        string    `gorm:"size:255;index" json:"path"`
	OrderIdx    int       `gorm:"default:0" json:"order_idx"`
	CreatedAt   time.Time `json:"created_at"`
	UpdatedAt   time.Time `json:"updated_at"`

	// MemberIDs is the set of users directly assigned to this department. It is
	// not a column (gorm:"-"): the list handler populates it in one batched
	// query so the frontend can render member counts and the member panel.
	MemberIDs []uint64 `gorm:"-" json:"member_ids,omitempty"`
}

func (Department) TableName() string { return "departments" }

// UserDepartment is the many-to-many membership between users and departments.
// A user may belong to several departments (借调 / 兼岗). users.department_id is
// kept as a denormalised "primary" pointer for back-compat display/filtering.
type UserDepartment struct {
	UserID       uint64    `gorm:"primaryKey" json:"user_id"`
	DepartmentID uint64    `gorm:"primaryKey" json:"department_id"`
	JoinedAt     time.Time `json:"joined_at"`
}

func (UserDepartment) TableName() string { return "user_departments" }
