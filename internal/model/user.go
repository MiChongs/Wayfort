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
	// DepartmentID is the denormalised "primary" department (first of the
	// user's departments). Source of truth for membership is the
	// user_departments join table; this column is kept for back-compat display
	// and quick filtering. See DepartmentIDs.
	DepartmentID *uint64 `gorm:"index" json:"department_id,omitempty"`

	// DepartmentIDs is the full set of departments the user belongs to. Not a
	// column (gorm:"-"): handlers populate it from the user_departments table.
	DepartmentIDs []uint64 `gorm:"-" json:"department_ids,omitempty"`

	// TagIDs is the set of managed tags (asset_tags rows) pinned to this user.
	// Not a column (gorm:"-"): handlers populate it from the user_tags table.
	TagIDs []uint64 `gorm:"-" json:"tag_ids,omitempty"`

	// Legacy quick admin flag. New code SHOULD use RBAC; we keep this for the
	// bootstrap admin and to short-circuit permission checks on the very first
	// user before any roles exist.
	IsAdmin  bool `gorm:"default:false" json:"is_admin"`
	Disabled bool `gorm:"default:false" json:"disabled"`

	// Account lifecycle. Status gates login (see IsActive); an empty string on
	// legacy rows is treated as active. ExpiresAt locks the account out once
	// reached (nil = never expires). Note is a free-text admin memo.
	Status    string     `gorm:"size:16;default:'active'" json:"status"`
	ExpiresAt *time.Time `gorm:"index" json:"expires_at,omitempty"`
	Note      string     `gorm:"size:1024" json:"note,omitempty"`

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

// Account lifecycle states. An empty Status (legacy rows) is treated as active.
const (
	UserStatusActive    = "active"    // 在职 / 正常
	UserStatusSuspended = "suspended" // 临时停用：保留账号但拒绝登录
	UserStatusDeparted  = "departed"  // 已离职：归档，拒绝登录
)

// IsActive reports whether the account may log in right now: not disabled, not
// suspended/departed, and not past its expiry. Empty Status counts as active so
// pre-existing rows keep working after the migration adds the column.
func (u *User) IsActive(now time.Time) bool {
	if u.Disabled || u.Status == UserStatusSuspended || u.Status == UserStatusDeparted {
		return false
	}
	if u.ExpiresAt != nil && !u.ExpiresAt.After(now) {
		return false
	}
	return true
}

// UserTag binds a managed tag (an asset_tags row) to a user, mirroring NodeTag
// so the same colourful, grouped tag vocabulary applies to people too.
type UserTag struct {
	UserID uint64 `gorm:"primaryKey" json:"user_id"`
	TagID  uint64 `gorm:"primaryKey" json:"tag_id"`
}

func (UserTag) TableName() string { return "user_tags" }
