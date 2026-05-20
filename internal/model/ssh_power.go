package model

import "time"

// Phase 12 — SSH power features.
//
// Two pillars:
//
//   1. **User SSH keys** — per-user owned ED25519/RSA keypairs. Used in
//      two flows: (a) "bring your own key" credential generation when
//      bootstrapping an account on a new node, and (b) pubkey display in
//      the UI so operators can paste it into authorized_keys without
//      hand-rolling ssh-keygen.
//
//   2. **Known hosts** — record of accepted SSH host fingerprints per
//      node. Replaces the silent TOFU file with an auditable table so
//      users can inspect / revoke trust through the UI.
//
//   3. **Bulk run** — orchestration history. Each row is one batch of
//      `command` against a list of `target_node_ids`. Results live in
//      BulkRunResult (one row per node) so the UI can render a per-node
//      drill-down.

// SSHKey — user-owned keypair. Private bytes are encrypted via the Sealer
// (same primitive as Credential.Secret); Public is stored as the canonical
// ssh-* one-liner (no encryption — it's a pubkey).
type SSHKey struct {
	ID         uint64 `gorm:"primaryKey" json:"id"`
	UserID     uint64 `gorm:"index;not null" json:"user_id"`
	Name       string `gorm:"size:128;not null" json:"name"`
	Type       string `gorm:"size:32;not null" json:"type"`            // "ed25519" | "rsa-2048" | "rsa-3072" | "rsa-4096"
	Public     string `gorm:"size:1024;not null" json:"public"`        // ssh-ed25519 AAA…  comment
	// Private/Passphrase are AES-GCM ciphertexts produced by the Phase 14
	// envelope vault. Phase 12 originally specified varbinary(N) for MySQL;
	// the codebase has since migrated to PostgreSQL where bytea is the
	// variable-length blob type (varbinary is MySQL-only — PG would error
	// at AutoMigrate time with SQLSTATE 42704).
	Private    []byte `gorm:"type:bytea" json:"-"` // AES-256-GCM ciphertext
	Passphrase []byte `gorm:"type:bytea" json:"-"` // ciphertext (may be empty)
	// Fingerprint is the SHA-256 fingerprint of Public (matches `ssh-keygen -lf`).
	Fingerprint string `gorm:"size:128" json:"fingerprint"`
	CreatedAt   time.Time `json:"created_at"`
	UpdatedAt   time.Time `json:"updated_at"`
	LastUsedAt  *time.Time `json:"last_used_at,omitempty"`
}

func (SSHKey) TableName() string { return "ssh_keys" }

// KnownHost — accepted SSH server fingerprint for a node/host:port. One
// row per (user_id, node_id, host:port) tuple. When status = "revoked"
// the dialler refuses to connect; when "trusted" it auto-accepts.
type KnownHost struct {
	ID          uint64    `gorm:"primaryKey" json:"id"`
	UserID      uint64    `gorm:"index;not null" json:"user_id"`
	NodeID      *uint64   `gorm:"index" json:"node_id,omitempty"`
	HostAddr    string    `gorm:"size:256;not null" json:"host_addr"` // e.g. "10.0.0.5:22"
	HostKeyType string    `gorm:"size:32;not null" json:"host_key_type"`
	Fingerprint string    `gorm:"size:128;not null" json:"fingerprint"`
	Status      string    `gorm:"size:16;default:'trusted'" json:"status"` // trusted | revoked
	AcceptedAt  time.Time `json:"accepted_at"`
	LastSeenAt  *time.Time `json:"last_seen_at,omitempty"`
	Notes       string     `gorm:"size:256" json:"notes,omitempty"`
}

func (KnownHost) TableName() string { return "ssh_known_hosts" }

// BulkRun — one batched command execution job. CreatedAt + DurationMs
// help the UI render a chronological log; aggregate stats live alongside
// the per-node results.
type BulkRun struct {
	ID         uint64    `gorm:"primaryKey" json:"id"`
	UserID     uint64    `gorm:"index;not null" json:"user_id"`
	Title      string    `gorm:"size:128;not null" json:"title"`
	Command    string    `gorm:"type:text;not null" json:"command"`
	// NodeIDs is a JSON array of uint64 IDs. Serialised in the handler.
	NodeIDs    string `gorm:"type:text;not null" json:"node_ids_json"`
	NodeCount  int    `gorm:"not null" json:"node_count"`
	OKCount    int    `gorm:"default:0" json:"ok_count"`
	FailCount  int    `gorm:"default:0" json:"fail_count"`
	DurationMs int64  `gorm:"default:0" json:"duration_ms"`
	// Truncated free-text summary used by list views to avoid a JOIN.
	Summary    string    `gorm:"size:512" json:"summary,omitempty"`
	CreatedAt  time.Time `gorm:"index" json:"created_at"`
}

func (BulkRun) TableName() string { return "ssh_bulk_runs" }

// BulkRunResult — one row per node touched by a BulkRun.
type BulkRunResult struct {
	ID         uint64 `gorm:"primaryKey" json:"id"`
	RunID      uint64 `gorm:"index;not null" json:"run_id"`
	NodeID     uint64 `gorm:"not null" json:"node_id"`
	NodeName   string `gorm:"size:128" json:"node_name"`
	// PG: text is the unbounded variable-length string type; longtext is
	// MySQL-only and trips SQLSTATE 42704 at AutoMigrate on a PG cluster.
	// Bulk-run stdout/stderr can be megabytes for `journalctl` style
	// commands, so we don't cap them with VARCHAR.
	Stdout     string `gorm:"type:text" json:"stdout"`
	Stderr     string `gorm:"type:text" json:"stderr"`
	ExitCode   int    `json:"exit_code"`
	DurationMs int64  `json:"duration_ms"`
	Error      string `gorm:"size:512" json:"error,omitempty"`
	CreatedAt  time.Time `json:"created_at"`
}

func (BulkRunResult) TableName() string { return "ssh_bulk_run_results" }
