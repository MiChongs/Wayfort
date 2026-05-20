package model

import "time"

type MFAType string

const (
	MFATypeTOTP  MFAType = "totp"
	MFATypeEmail MFAType = "email"
)

// UserMFA stores one MFA factor. A user may have multiple TOTP devices.
type UserMFA struct {
	ID              uint64     `gorm:"primaryKey" json:"id"`
	UserID          uint64     `gorm:"index;not null" json:"user_id"`
	Type            MFAType    `gorm:"size:16;not null" json:"type"`
	DisplayName     string     `gorm:"size:128" json:"display_name"`
	SecretEncrypted []byte     `json:"-"`
	Enabled         bool       `gorm:"default:false" json:"enabled"`
	LastUsedAt      *time.Time `json:"last_used_at,omitempty"`
	CreatedAt       time.Time  `json:"created_at"`
}

func (UserMFA) TableName() string { return "user_mfa" }

// UserRecoveryCode is one of the one-time codes a user can use to bypass MFA
// when they've lost their authenticator. CodeHash is bcrypt.
type UserRecoveryCode struct {
	ID       uint64     `gorm:"primaryKey" json:"id"`
	UserID   uint64     `gorm:"index;not null" json:"user_id"`
	CodeHash string     `gorm:"size:128;not null" json:"-"`
	Used     bool       `gorm:"default:false;index" json:"used"`
	UsedAt   *time.Time `json:"used_at,omitempty"`
	CreatedAt time.Time `json:"created_at"`
}

func (UserRecoveryCode) TableName() string { return "user_recovery_codes" }
