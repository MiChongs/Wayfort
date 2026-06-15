package model

import "time"

// PKICA is the persisted embedded certificate authority (security-architecture.md
// §6). Exactly one row is active. The private key is stored KMS-enveloped
// (KeySealed is the vault pointer, never the raw key), so a database dump alone
// can't recover the trust root.
type PKICA struct {
	ID        uint64    `gorm:"primaryKey" json:"id"`
	CertPEM   string    `gorm:"type:text;not null" json:"cert_pem"`
	KeySealed []byte    `gorm:"type:bytea;not null" json:"-"`
	Active    bool      `gorm:"index" json:"active"`
	CreatedAt time.Time `json:"created_at"`
}

func (PKICA) TableName() string { return "pki_ca" }

// PKICertificate is the issued-certificate ledger: one row per leaf cert the CA
// signs, so the admin can audit and revoke. Revocation is by serial; the tunnel
// path checks RevokedAt before trusting a presented cert.
type PKICertificate struct {
	ID          uint64 `gorm:"primaryKey" json:"id"`
	Serial      string `gorm:"size:64;uniqueIndex;not null" json:"serial"`
	// SubjectKind is what the cert was issued to: "agent" (M3) or "service".
	SubjectKind string `gorm:"size:16;not null" json:"subject_kind"`
	SubjectID   uint64 `gorm:"index" json:"subject_id"`
	// Fingerprint is the SHA-256 (hex) of the cert DER — the identity the tunnel
	// binds to (matches GatewayAgent.Fingerprint).
	Fingerprint string `gorm:"size:64;index" json:"fingerprint"`

	NotBefore time.Time  `json:"not_before"`
	NotAfter  time.Time  `json:"not_after"`
	RevokedAt *time.Time `json:"revoked_at,omitempty"`
	RevokeReason string  `gorm:"size:255" json:"revoke_reason,omitempty"`

	CreatedAt time.Time `json:"created_at"`
}

func (PKICertificate) TableName() string { return "pki_certificates" }

// Revoked reports whether the certificate has been revoked.
func (c *PKICertificate) Revoked() bool { return c != nil && c.RevokedAt != nil }
