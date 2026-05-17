package model

import "time"

type LoginResult string

const (
	LoginSuccess     LoginResult = "success"
	LoginFailed      LoginResult = "fail"
	LoginLocked      LoginResult = "locked"
	LoginMFARequired LoginResult = "mfa_required"
	LoginMFAFailed   LoginResult = "mfa_failed"
)

type AuthMethod string

const (
	AuthMethodPassword AuthMethod = "password"
	AuthMethodPasskey  AuthMethod = "passkey"
	AuthMethodOIDC     AuthMethod = "oidc"
	AuthMethodRecovery AuthMethod = "recovery"
)

type MFAMethod string

const (
	MFAMethodNone     MFAMethod = "none"
	MFAMethodTOTP     MFAMethod = "totp"
	MFAMethodEmail    MFAMethod = "email"
	MFAMethodPasskey  MFAMethod = "passkey"
	MFAMethodRecovery MFAMethod = "recovery"
)

// LoginHistory records each authentication attempt for audit and anomaly
// detection. UserID is nullable so we can record attempts where the username
// didn't even resolve to a user.
type LoginHistory struct {
	ID           uint64      `gorm:"primaryKey" json:"id"`
	UserID       *uint64     `gorm:"index" json:"user_id,omitempty"`
	Username     string      `gorm:"size:64;index" json:"username"`
	IP           string      `gorm:"size:64;index" json:"ip"`
	UserAgent    string      `gorm:"size:255" json:"user_agent"`
	GeoCountry   string      `gorm:"size:64" json:"geo_country,omitempty"`
	GeoCity      string      `gorm:"size:128" json:"geo_city,omitempty"`
	Result       LoginResult `gorm:"size:24;index" json:"result"`
	AuthMethod   AuthMethod  `gorm:"size:24" json:"auth_method"`
	MFAMethod    MFAMethod   `gorm:"size:24" json:"mfa_method"`
	OIDCProvider string      `gorm:"size:64" json:"oidc_provider,omitempty"`
	Anomaly      bool        `gorm:"index" json:"anomaly"`
	Reason       string      `gorm:"size:255" json:"reason,omitempty"`
	CreatedAt    time.Time   `gorm:"index" json:"created_at"`
}

func (LoginHistory) TableName() string { return "login_histories" }
