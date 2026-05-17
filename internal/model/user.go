package model

import "time"

type User struct {
	ID           uint64  `gorm:"primaryKey" json:"id"`
	Username     string  `gorm:"size:64;uniqueIndex;not null" json:"username"`
	PasswordHash string  `gorm:"size:128;not null" json:"-"`
	DisplayName  string  `gorm:"size:128" json:"display_name"`
	Email        string  `gorm:"size:128;index" json:"email"`
	Phone        string  `gorm:"size:32" json:"phone,omitempty"`
	AvatarURL    string  `gorm:"size:512" json:"avatar_url,omitempty"`
	DepartmentID *uint64 `gorm:"index" json:"department_id,omitempty"`

	// Legacy quick admin flag. New code SHOULD use RBAC; we keep this for the
	// bootstrap admin and to short-circuit permission checks on the very first
	// user before any roles exist.
	IsAdmin  bool `gorm:"default:false" json:"is_admin"`
	Disabled bool `gorm:"default:false" json:"disabled"`

	// Auth security state.
	LastLoginAt     *time.Time `json:"last_login_at,omitempty"`
	LastLoginIP     string     `gorm:"size:64" json:"last_login_ip,omitempty"`
	LastUserAgent   string     `gorm:"size:255" json:"last_user_agent,omitempty"`
	LockedUntil     *time.Time `gorm:"index" json:"locked_until,omitempty"`
	MFAEnforced     bool       `gorm:"default:false" json:"mfa_enforced"`
	PasskeyOnly     bool       `gorm:"default:false" json:"passkey_only"`
	PasswordChanged *time.Time `json:"password_changed,omitempty"`

	CreatedAt time.Time `json:"created_at"`
	UpdatedAt time.Time `json:"updated_at"`
}

func (User) TableName() string { return "users" }
