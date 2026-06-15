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
	GeoCountryISO string     `gorm:"size:8;index" json:"geo_country_iso,omitempty"`
	GeoRegion    string      `gorm:"size:128" json:"geo_region,omitempty"`
	GeoCity      string      `gorm:"size:128" json:"geo_city,omitempty"`
	GeoLat       float64     `gorm:"" json:"geo_lat,omitempty"`
	GeoLon       float64     `gorm:"" json:"geo_lon,omitempty"`
	ASN          uint        `gorm:"" json:"asn,omitempty"`
	ASNOrg       string      `gorm:"size:128" json:"asn_org,omitempty"`
	Result       LoginResult `gorm:"size:24;index" json:"result"`
	AuthMethod   AuthMethod  `gorm:"size:24" json:"auth_method"`
	MFAMethod    MFAMethod   `gorm:"size:24" json:"mfa_method"`
	OIDCProvider string      `gorm:"size:64" json:"oidc_provider,omitempty"`
	Anomaly      bool        `gorm:"index" json:"anomaly"`
	// RiskScore is the 0–100 anomaly score assigned by the detector (0 on normal
	// or unscored rows). AnomalyReasons is a comma-separated list of machine
	// reason codes (new_ip, new_country, new_asn, new_device, impossible_travel,
	// brute_force) explaining why the login was flagged.
	RiskScore      int    `gorm:"index" json:"risk_score,omitempty"`
	AnomalyReasons string `gorm:"size:255" json:"anomaly_reasons,omitempty"`
	Reason         string `gorm:"size:255" json:"reason,omitempty"`
	CreatedAt      time.Time `gorm:"index" json:"created_at"`
}

func (LoginHistory) TableName() string { return "login_histories" }
