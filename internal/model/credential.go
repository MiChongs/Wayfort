package model

import "time"

// CredentialKind enumerates supported authentication materials.
type CredentialKind string

const (
	CredentialPassword   CredentialKind = "password"
	CredentialPrivateKey CredentialKind = "private_key"
	CredentialAgent      CredentialKind = "agent"
)

// Credential holds an encrypted secret blob. Starting with Phase 14, the
// Secret / Passphrase columns store an opaque envelope pointer (see
// pkg/crypto.Vault) — a magic prefix followed by a varint envelope ID. The
// real ciphertext + per-credential DEK live in the `secret_envelopes` table
// and the DEK itself is wrapped by a KMS-managed KEK (Vault/OpenBao Transit
// or one of AWS/Azure/GCP KMS). Legacy AES-256-GCM blobs produced by the
// old pkg/crypto.Sealer remain readable during the migration window if a
// `legacy_master_key_hex` row is configured in the KMS table.
type Credential struct {
	ID         uint64         `gorm:"primaryKey" json:"id"`
	Name       string         `gorm:"size:128;not null" json:"name"`
	Kind       CredentialKind `gorm:"size:32;not null" json:"kind"`
	Username   string         `gorm:"size:128" json:"username"`
	Passphrase []byte         `json:"-"`
	Secret     []byte         `json:"-"`
	CreatedAt  time.Time      `json:"created_at"`
	UpdatedAt  time.Time      `json:"updated_at"`
}

func (Credential) TableName() string { return "credentials" }
