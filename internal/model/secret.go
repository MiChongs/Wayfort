package model

import "time"

// Phase 14 — credential pool envelope encryption.
//
// Background
// ----------
// Earlier phases stored credential ciphertext inline in the owning table
// (Credential.Secret, OIDCClient.ClientSecretEncrypted, etc.) using a single
// AES-256-GCM key loaded from `crypto.master_key_hex` in the YAML config.
// That violates the bare-minimum bar laid out in the Phase 14 brief:
//
//   - one fixed AES key for all rows
//   - master key sitting in a config file (or worse, an env var)
//   - no AAD binding to business context
//   - no per-decrypt audit
//   - no key rotation path
//
// Phase 14 replaces that model with envelope encryption:
//
//   - every secret has its own random DEK (Data Encryption Key)
//   - the DEK is wrapped by a KEK (Key Encryption Key) managed externally
//     in HashiCorp Vault / OpenBao Transit, AWS KMS, Azure Key Vault or
//     GCP Cloud KMS
//   - we persist {ciphertext, nonce, encrypted_dek, key_id, key_version,
//     aad_hash, algorithm, version} in this table; the KEK never reaches
//     the application
//   - AAD is constructed from {owner_type, owner_id, version} so a
//     ciphertext tampered to point at a different row fails authentication
//   - every decrypt writes a row to secret_audits with user_id, source_ip,
//     reason and result
//   - rewrap (re-wrap encrypted_dek under a new KEK version) lets us
//     rotate the KEK without touching the per-row DEK or re-encrypting
//     the payload
//
// The owning rows (Credential, OIDCClient, UserMFA, AIProvider, ...) hold
// an opaque pointer in their existing bytes column; the canonical envelope
// is stored here.

// SecretEnvelopeStatus tracks the lifecycle of a single envelope.
type SecretEnvelopeStatus string

const (
	// EnvelopeActive is the live row used by the owning entity. Exactly
	// one envelope per (owner_type, owner_id) should be Active at any
	// time; older versions stay around as Rotated for audit + roll-back.
	EnvelopeActive SecretEnvelopeStatus = "active"
	// EnvelopeRotated marks an envelope superseded by a newer Version.
	// We keep them so audit trails referring to KeyID + KeyVersion stay
	// resolvable, and so a botched rotation can be rolled back without
	// hitting the KMS again.
	EnvelopeRotated SecretEnvelopeStatus = "rotated"
	// EnvelopeRevoked marks an envelope that should never be decrypted
	// again (compromised KEK, leaked DEK, manual security action).
	EnvelopeRevoked SecretEnvelopeStatus = "revoked"
)

// SecretEnvelopeOwnerType is the discriminator used by AAD construction +
// audit. Each constant maps to one table that has migrated to envelope
// storage. Adding a new owner type means: (a) point its column at the
// envelope ID + (b) include the new constant in AAD construction
// (internal/secrets.AADFor).
type SecretEnvelopeOwnerType string

const (
	OwnerCredentialSecret      SecretEnvelopeOwnerType = "credential.secret"
	OwnerCredentialPassphrase  SecretEnvelopeOwnerType = "credential.passphrase"
	OwnerOIDCClientSecret      SecretEnvelopeOwnerType = "oidc_client.secret"
	OwnerUserMFASecret         SecretEnvelopeOwnerType = "user_mfa.secret"
	OwnerAIProviderAPIKey      SecretEnvelopeOwnerType = "ai_provider.api_key"
	OwnerPKICAKey              SecretEnvelopeOwnerType = "pki.ca_key"
	OwnerGeneric               SecretEnvelopeOwnerType = "generic"
)

// SecretEnvelope is one wrapped credential. The canonical decrypt flow is
// `internal/secrets.Service.Decrypt(env, aad, audit)` — that takes the
// row + the caller-supplied audit context, hits the KMS to unwrap
// EncryptedDEK, validates AAD against AADHash, decrypts Ciphertext, and
// writes a SecretAudit row before returning plaintext.
//
// Plaintext is NEVER stored, returned to the frontend or logged. Callers
// are responsible for clearing it from memory after use.
type SecretEnvelope struct {
	ID        uint64                  `gorm:"primaryKey" json:"id"`
	OwnerType SecretEnvelopeOwnerType `gorm:"size:64;index:idx_envelope_owner,priority:1;not null" json:"owner_type"`
	OwnerID   uint64                  `gorm:"index:idx_envelope_owner,priority:2;not null" json:"owner_id"`

	// AEAD ciphertext of the plaintext credential. AES-256-GCM by
	// default; XChaCha20-Poly1305 reserved for non-cgo / no-AES-NI
	// deployments via Algorithm.
	Ciphertext []byte `json:"-"`
	// Nonce / IV for the AEAD. 12 bytes for AES-256-GCM, 24 bytes for
	// XChaCha20-Poly1305.
	Nonce []byte `json:"-"`
	// EncryptedDEK is the per-row DEK after being wrapped by the KMS
	// KEK identified by ProviderID / KeyID / KeyVersion. The KMS-specific
	// wire format is preserved here verbatim — Vault Transit gives
	// "vault:v3:base64", AWS KMS hands back a binary CiphertextBlob,
	// Azure / GCP each have their own layouts. The provider that wrote
	// the blob is the only one that can unwrap it.
	EncryptedDEK []byte `json:"-"`

	// ProviderID references the kms_providers row that wrapped the DEK.
	// Required so decrypt can route to the right KMS even after
	// providers are added / disabled / renamed.
	ProviderID uint64 `gorm:"index;not null" json:"provider_id"`
	// KeyID is the KMS-side key name. For Vault Transit it's the key
	// name (e.g. "jumpserver-creds"), for AWS KMS the key alias or
	// CMK ID, for Azure the key URI, for GCP the resource path.
	KeyID string `gorm:"size:256;not null" json:"key_id"`
	// KeyVersion captures which version of the KEK wrapped this DEK.
	// Vault Transit + GCP + Azure all expose a numeric key version;
	// AWS KMS only exposes "the current version of the CMK" so we
	// store 1 there and rely on AWS's own automatic rotation tracking.
	KeyVersion int    `gorm:"default:1" json:"key_version"`
	Algorithm  string `gorm:"size:32;not null;default:'aes-256-gcm'" json:"algorithm"`

	// AADHash is sha256(canonical_aad). Canonical AAD is
	// `owner_type|owner_id|version` plus optional caller-supplied
	// per-tenant context. Storing only the hash (32 bytes) keeps the
	// row small and still lets us verify on decrypt that the envelope
	// is being opened in the same business context it was sealed in.
	AADHash []byte `gorm:"size:32;not null" json:"-"`

	// Version is the per-owner credential version number. Bumped on
	// credential rotation; lets us roll back to a previous secret
	// without losing the row that wrapped it.
	Version int                  `gorm:"default:1" json:"version"`
	Status  SecretEnvelopeStatus `gorm:"size:16;not null;default:'active';index" json:"status"`

	CreatedAt time.Time  `json:"created_at"`
	RotatedAt *time.Time `json:"rotated_at,omitempty"`
}

func (SecretEnvelope) TableName() string { return "secret_envelopes" }

// KMSProviderKind enumerates the supported external key managers.
type KMSProviderKind string

const (
	// KMSKindVault — HashiCorp Vault / OpenBao Transit engine.
	// Recommended for self-hosted / on-prem deployments. We authenticate
	// via AppRole (RoleID + sealed SecretID) or a token bootstrap file.
	KMSKindVault KMSProviderKind = "vault"
	// KMSKindAWS — AWS KMS. Authenticated via the standard AWS SDK
	// credential chain (IMDS, EC2 instance profile, IRSA, etc.). The
	// CMK alias / ARN goes in KeyID.
	KMSKindAWS KMSProviderKind = "aws_kms"
	// KMSKindAzure — Azure Key Vault. Authenticated via DefaultAzureCredential
	// (Managed Identity, Workload Identity, az CLI, environment vars).
	// VaultURL + KeyName in Endpoint / KeyID.
	KMSKindAzure KMSProviderKind = "azure_keyvault"
	// KMSKindGCP — GCP Cloud KMS. Authenticated via Application Default
	// Credentials (Workload Identity, GCE service account, gcloud).
	// Full resource path (projects/.../keyRings/.../cryptoKeys/...) in KeyID.
	KMSKindGCP KMSProviderKind = "gcp_kms"
	// KMSKindLocal — file-backed local KEK. Bootstrap-only; intended
	// for first-boot before an admin configures a real KMS, and for
	// hermetic test deployments. The KEK lives in a 0600 file outside
	// the DB. Operators are nudged to upgrade via the setup banner
	// when this provider stays active.
	KMSKindLocal KMSProviderKind = "local"
)

// KMSProvider is one configured external key manager. Multiple may be
// registered; exactly one row is IsPrimary at a time and that's the one
// new envelopes are wrapped under. Decrypt-time routing uses the
// ProviderID stored on the envelope itself, so older envelopes wrapped
// under a now-secondary provider still decrypt correctly.
type KMSProvider struct {
	ID          uint64          `gorm:"primaryKey" json:"id"`
	Name        string          `gorm:"size:64;uniqueIndex;not null" json:"name"`
	Kind        KMSProviderKind `gorm:"size:32;not null" json:"kind"`
	DisplayName string          `gorm:"size:128" json:"display_name"`
	Description string          `gorm:"size:512" json:"description,omitempty"`

	// Endpoint is the KMS-specific connection target:
	//   - Vault: https://vault.internal:8200
	//   - AWS: region name (e.g. "us-east-1"); endpoint URL goes in ExtraJSON
	//   - Azure: full Key Vault URL https://my-kv.vault.azure.net
	//   - GCP: usually empty (auth via ADC); region goes in ExtraJSON
	//   - Local: filesystem path of the sealed keystore
	Endpoint string `gorm:"size:512" json:"endpoint"`
	// KeyID is the canonical key identifier used by Encrypt:
	//   - Vault: transit key name
	//   - AWS: alias/<name> or full CMK ARN
	//   - Azure: key name (the URL is in Endpoint)
	//   - GCP: full resource path projects/.../cryptoKeys/...
	//   - Local: opaque alias (e.g. "primary")
	KeyID string `gorm:"size:512;not null" json:"key_id"`
	// Namespace is the Vault namespace (Vault Enterprise multi-tenancy)
	// or GCP project ID override. Empty for default tenancy.
	Namespace string `gorm:"size:128" json:"namespace,omitempty"`

	// AuthMethod selects how we talk to the KMS:
	//   - Vault: "approle" | "token" | "kubernetes"
	//   - AWS:   "default" (rely on SDK chain) | "static" (use AuthCiphertext)
	//   - Azure: "default" (rely on DefaultAzureCredential) | "client_secret"
	//   - GCP:   "default" (ADC) | "service_account"
	//   - Local: "" (no auth)
	AuthMethod string `gorm:"size:32" json:"auth_method,omitempty"`
	// AuthRoleID is the public half of an AppRole identifier (Vault) or
	// the Azure tenant ID. Never a secret — safe to store in cleartext.
	AuthRoleID string `gorm:"size:256" json:"auth_role_id,omitempty"`
	// AuthCiphertext is the secret half — Vault SecretID, AWS static
	// secret access key, Azure client secret, GCP service account JSON.
	// It is sealed by a bootstrap key derived from the kms_seal row
	// (see KMSSealMaterial below). NEVER stored in plaintext.
	AuthCiphertext []byte `json:"-"`

	// ExtraJSON carries provider-specific knobs (Vault TLS skipping flag,
	// AWS endpoint URL, Azure HSM vs. software key flag, GCP location).
	// JSON is overkill for a few fields but keeps the schema stable while
	// per-provider tuning evolves.
	ExtraJSON string `gorm:"type:text" json:"extra,omitempty"`

	IsPrimary bool      `gorm:"index" json:"is_primary"`
	Enabled   bool      `gorm:"default:true" json:"enabled"`
	CreatedAt time.Time `json:"created_at"`
	UpdatedAt time.Time `json:"updated_at"`
}

func (KMSProvider) TableName() string { return "kms_providers" }

// SecretAuditOperation tags the kind of access that triggered the audit
// row. Decrypt is the high-traffic case; encrypt/rewrap/rotate get one
// row each per credential lifecycle event.
type SecretAuditOperation string

const (
	AuditOpEncrypt SecretAuditOperation = "encrypt"
	AuditOpDecrypt SecretAuditOperation = "decrypt"
	AuditOpRewrap  SecretAuditOperation = "rewrap"
	AuditOpRotate  SecretAuditOperation = "rotate"
	AuditOpRevoke  SecretAuditOperation = "revoke"
)

// SecretAudit captures every credential-pool access — successful or
// failed. Failed decrypts are especially important to surface: they're
// either a misconfigured KMS, a corrupted envelope, or an attack.
type SecretAudit struct {
	ID        uint64                  `gorm:"primaryKey" json:"id"`
	OwnerType SecretEnvelopeOwnerType `gorm:"size:64;index:idx_audit_owner,priority:1" json:"owner_type"`
	OwnerID   uint64                  `gorm:"index:idx_audit_owner,priority:2" json:"owner_id"`
	EnvelopeID uint64                 `gorm:"index" json:"envelope_id,omitempty"`

	Operation SecretAuditOperation `gorm:"size:16;not null;index" json:"operation"`
	Success   bool                 `gorm:"index" json:"success"`
	ErrorMsg  string               `gorm:"size:1024" json:"error_msg,omitempty"`

	// Caller identity. Optional because some operations happen during
	// startup or background jobs.
	UserID   *uint64 `gorm:"index" json:"user_id,omitempty"`
	Username string  `gorm:"size:128" json:"username,omitempty"`
	SourceIP string  `gorm:"size:64" json:"source_ip,omitempty"`
	// Reason is the human-supplied context (ticket ID, approval ID,
	// "session connect", etc.) that justifies this access. Required
	// for high-privilege decrypts; optional otherwise.
	Reason   string `gorm:"size:512" json:"reason,omitempty"`
	TicketID string `gorm:"size:128" json:"ticket_id,omitempty"`

	// KMS routing snapshot — preserved so audit queries don't have to
	// join secret_envelopes (which may have been rotated since).
	ProviderID uint64 `json:"provider_id,omitempty"`
	KeyID      string `gorm:"size:256" json:"key_id,omitempty"`
	KeyVersion int    `json:"key_version,omitempty"`

	CreatedAt time.Time `gorm:"index" json:"created_at"`
}

func (SecretAudit) TableName() string { return "secret_audits" }

// KMSSealMaterial holds the bootstrap material needed to decrypt
// KMSProvider.AuthCiphertext. There is exactly one row (singleton).
//
// Rationale: the user goal forbids storing master keys in config files or
// environment variables. But we still need *some* way to bootstrap the
// chain — somebody has to be allowed to read the Vault AppRole secret_id
// after a fresh `systemctl restart jumpserver`. We solve that by:
//
//   1. The KEK that actually wraps DEKs lives in Vault / KMS (per goal).
//   2. The auth credential for that KMS (Vault SecretID, etc.) is sealed
//      by a *bootstrap key* derived from a single secret value the
//      operator provides ONCE at install time.
//   3. The bootstrap key is stored in this DB row as a passphrase-derived
//      blob (Argon2id-stretched material + salt). The passphrase itself
//      lives in a single 0600 file on disk (`var/keystore.unseal`), NOT
//      in the YAML config and NOT in any environment variable.
//
// On startup we read the unseal file, derive the same key, decrypt
// KMSProvider.AuthCiphertext rows, and the gateway can talk to its
// configured KMS. If the unseal file is missing, we boot in a sealed
// mode where only /api/v1/setup/* endpoints work — admin re-supplies
// the passphrase and we re-write the file.
//
// This is the only secret material that ever touches local disk and
// it sits behind file permissions, not config / env / argv. Operators
// who need stronger guarantees can mount that file from a hardware
// keystore or systemd-credential.
type KMSSealMaterial struct {
	ID uint64 `gorm:"primaryKey" json:"id"`
	// Salt is the per-installation salt used in Argon2id. 16 bytes.
	Salt []byte `json:"-"`
	// Verifier is Argon2id(passphrase, Salt). 32 bytes. On boot we
	// re-derive and constant-time compare; a mismatch means the
	// passphrase is wrong.
	Verifier []byte `json:"-"`
	// CreatedAt records when the seal material was minted.
	CreatedAt time.Time `json:"created_at"`
	// UnsealedAt records the most recent successful unseal — useful for
	// the setup-status endpoint.
	UnsealedAt *time.Time `json:"unsealed_at,omitempty"`
}

func (KMSSealMaterial) TableName() string { return "kms_seal_material" }
