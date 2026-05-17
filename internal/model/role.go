package model

import "time"

// Role groups a bundle of permission codes. System roles (admin/operator/auditor/guest)
// are seeded at boot and cannot be deleted.
type Role struct {
	ID          uint64    `gorm:"primaryKey" json:"id"`
	Name        string    `gorm:"size:64;uniqueIndex;not null" json:"name"`
	Description string    `gorm:"size:255" json:"description"`
	IsSystem    bool      `gorm:"default:false" json:"is_system"`
	CreatedAt   time.Time `json:"created_at"`
	UpdatedAt   time.Time `json:"updated_at"`
}

func (Role) TableName() string { return "roles" }

// Permission is a single capability code, e.g. "node:create". Rows in this table
// are populated by the application on boot; they're documented for the UI.
type Permission struct {
	Code        string    `gorm:"primaryKey;size:64" json:"code"`
	Description string    `gorm:"size:255" json:"description"`
	Category    string    `gorm:"size:32;index" json:"category"`
	CreatedAt   time.Time `json:"created_at"`
}

func (Permission) TableName() string { return "permissions" }

// RolePermission is the M:N join between Role and Permission.
type RolePermission struct {
	RoleID         uint64 `gorm:"primaryKey" json:"role_id"`
	PermissionCode string `gorm:"primaryKey;size:64" json:"permission_code"`
}

func (RolePermission) TableName() string { return "role_permissions" }

// UserRole grants a role to a user.
type UserRole struct {
	UserID    uint64    `gorm:"primaryKey" json:"user_id"`
	RoleID    uint64    `gorm:"primaryKey" json:"role_id"`
	GrantedAt time.Time `json:"granted_at"`
	GrantedBy *uint64   `json:"granted_by,omitempty"`
}

func (UserRole) TableName() string { return "user_roles" }
