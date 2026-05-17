package model

import "time"

// CredentialKind enumerates supported authentication materials.
type CredentialKind string

const (
	CredentialPassword   CredentialKind = "password"
	CredentialPrivateKey CredentialKind = "private_key"
	CredentialAgent      CredentialKind = "agent"
)

// Credential holds an encrypted secret blob. The Secret column is the AES-GCM
// ciphertext produced by pkg/crypto.Sealer; plaintext never touches the DB.
type Credential struct {
	ID         uint64         `gorm:"primaryKey" json:"id"`
	Name       string         `gorm:"size:128;not null" json:"name"`
	Kind       CredentialKind `gorm:"size:32;not null" json:"kind"`
	Username   string         `gorm:"size:128" json:"username"`
	Passphrase []byte         `gorm:"type:varbinary(2048)" json:"-"`
	Secret     []byte         `gorm:"type:varbinary(8192)" json:"-"`
	CreatedAt  time.Time      `json:"created_at"`
	UpdatedAt  time.Time      `json:"updated_at"`
}

func (Credential) TableName() string { return "credentials" }
