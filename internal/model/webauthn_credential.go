package model

import "time"

// WebauthnCredential stores one Passkey (FIDO2/WebAuthn) credential registered
// by a user. The CredentialID is the opaque handle returned by the browser
// (raw, not base64-encoded). PublicKey is COSE-encoded.
type WebauthnCredential struct {
	ID              uint64     `gorm:"primaryKey" json:"id"`
	UserID          uint64     `gorm:"index;not null" json:"user_id"`
	CredentialID    []byte     `gorm:"uniqueIndex;not null" json:"-"`
	PublicKey       []byte     `gorm:"not null" json:"-"`
	AAGUID          []byte     `json:"aaguid,omitempty"`
	SignCount       uint32     `json:"sign_count"`
	Transports      string     `gorm:"size:128" json:"transports,omitempty"`
	AttestationType string     `gorm:"size:32" json:"attestation_type,omitempty"`
	DisplayName     string     `gorm:"size:128" json:"display_name"`
	CloneWarning    bool       `gorm:"default:false" json:"clone_warning,omitempty"`
	UserVerified    bool       `gorm:"default:false" json:"user_verified"`
	BackupEligible  bool       `gorm:"default:false" json:"backup_eligible"`
	BackupState     bool       `gorm:"default:false" json:"backup_state"`
	CreatedAt       time.Time  `json:"created_at"`
	LastUsedAt      *time.Time `json:"last_used_at,omitempty"`
}

func (WebauthnCredential) TableName() string { return "webauthn_credentials" }
