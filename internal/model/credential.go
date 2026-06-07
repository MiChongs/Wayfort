package model

import "time"

// CredentialKind enumerates supported authentication materials.
type CredentialKind string

const (
	CredentialPassword   CredentialKind = "password"
	CredentialPrivateKey CredentialKind = "private_key"
	CredentialAgent      CredentialKind = "agent"
	// CredentialAccessKey holds an object-storage AccessKey pair: Username is the
	// AccessKey ID, Secret is the (KMS-encrypted) SecretKey. Used by OSS nodes.
	CredentialAccessKey CredentialKind = "access_key"
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

	// Phase 16 — when set, decrypting this credential's secret requires
	// an active credential_use grant for the calling user. Used for
	// privileged service accounts (root, Administrator, dba) that
	// shouldn't be reachable without a per-use approval. Default false →
	// no behavior change.
	RequiresApprovalForUse bool `gorm:"default:false" json:"requires_approval_for_use"`

	// --- Operator-facing lifecycle metadata (credential redesign) ---
	// Description is a free-form note ("what account is this, who owns it").
	Description string `gorm:"size:512" json:"description,omitempty"`
	// Tags is a comma-separated grouping string (e.g. "prod,linux,shared").
	// Mirrors Node.Tags / Proxy.Tags so the same filter UI applies everywhere.
	Tags string `gorm:"size:256" json:"tags,omitempty"`
	// ExpiresAt lets operators flag rotation deadlines. The UI surfaces an
	// amber "expiring" / red "expired" badge; nothing enforces it server-side
	// yet (no silent connection breakage on expiry).
	ExpiresAt *time.Time `json:"expires_at,omitempty"`
	// LastUsedAt is best-effort touched when the credential is resolved for a
	// live session (see CredentialRepo.TouchLastUsed). Helps spot stale creds.
	LastUsedAt *time.Time `json:"last_used_at,omitempty"`
	// LastTestedAt / LastTestOK record the most recent connectivity test from
	// the admin "test" endpoint so the list can show a freshness signal.
	LastTestedAt *time.Time `json:"last_tested_at,omitempty"`
	LastTestOK   *bool      `json:"last_test_ok,omitempty"`

	CreatedAt time.Time `json:"created_at"`
	UpdatedAt time.Time `json:"updated_at"`
}

func (Credential) TableName() string { return "credentials" }
