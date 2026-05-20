// Package kms is the KEK custody layer for the Phase 14 credential pool.
//
// Background
// ----------
// Earlier phases stored credential ciphertext directly in MySQL using a
// single fixed AES-256 master key loaded from `crypto.master_key_hex` in
// the YAML config. The Phase 14 brief calls that out as the worst-supported
// option short of plaintext: one key per row makes audit + rotation
// tractable, and the master key has no business being in a config file.
//
// What this package solves
// ------------------------
//   - We hold a small, narrow interface (KMS) that wraps and unwraps
//     per-row Data Encryption Keys (DEKs) without ever touching the
//     plaintext credential itself.
//   - The DEK plaintext is the only thing leaving the KMS during a
//     decrypt; even that lives in memory only for the duration of the
//     AEAD Open() call and is then wiped by the caller in
//     internal/secrets.
//   - The KEK that wraps the DEK lives in one of:
//
//       * HashiCorp Vault / OpenBao Transit (recommended for on-prem)
//       * AWS KMS                           (recommended for AWS)
//       * Azure Key Vault                   (recommended for Azure)
//       * GCP Cloud KMS                     (recommended for GCP)
//       * a local file                      (bootstrap / dev only)
//
//   - Configuration for every provider lives in the `kms_providers`
//     DB table — never in a config file and never in environment
//     variables (per the Phase 14 brief).
//
// Threat model
// ------------
//   - DB dump: attacker sees ciphertexts + wrapped DEKs. They can't
//     unwrap without the KMS, which they don't control.
//   - App config leak: there is no master key in the YAML or the env.
//     The closest thing — `var/keystore.unseal` — only unseals the
//     KMS auth credentials. Without network access to the KMS, those
//     are still useless.
//   - App memory dump: a live process briefly holds plaintext DEKs.
//     Mitigation is keeping decrypted DEKs in scope as short as
//     possible (internal/secrets does this) and wiping them.
//   - KMS compromise: out of scope. Rotate the KEK and rewrap all
//     envelopes.
package kms

import (
	"context"
	"errors"
	"fmt"
)

// Kind enumerates the supported KMS providers. The string values are
// stable; they match KMSProvider.Kind on the DB row.
type Kind string

const (
	KindVault Kind = "vault"
	KindAWS   Kind = "aws_kms"
	KindAzure Kind = "azure_keyvault"
	KindGCP   Kind = "gcp_kms"
	KindLocal Kind = "local"
)

// WrappedDEK is what a KMS hands back when wrapping a fresh DEK. We
// store all three fields on the envelope row so decrypt can route to
// the same provider + key version without ambiguity.
type WrappedDEK struct {
	// Ciphertext is the KMS-specific wire format of the wrapped DEK.
	// We treat it as opaque bytes — every provider has its own layout
	// and the only thing that can unwrap a given blob is the provider
	// that wrote it.
	Ciphertext []byte
	// KeyID is the KMS-side identifier for the KEK that wrapped this
	// DEK. The wrapper may have used an alias / latest-version pointer
	// even if the underlying material was a specific version — KeyID
	// is whatever Encrypt told us to remember.
	KeyID string
	// KeyVersion records the KEK version used. Providers that don't
	// expose key versions (AWS KMS, broadly) return 1.
	KeyVersion int
}

// KMS is the cross-provider contract. It is intentionally tiny: wrap a
// DEK, unwrap a DEK, rewrap a DEK under the latest KEK version. Any
// per-provider features (signing, HMAC, policy, audit) stay inside the
// concrete implementation.
//
// AAD support: the AEAD AAD that binds an envelope to its business
// context is computed in internal/secrets and applied inside the AES-GCM
// envelope — NOT here. KMS providers that natively support AAD (Vault
// Transit's "context", AWS KMS's EncryptionContext, GCP's additional
// authenticated data, Azure's not-natively-supported case) can opt into
// passing it via the optional EncryptionContext field on EncryptDEK.
// Providers that don't are still safe because the envelope AEAD is
// where the strong AAD binding lives.
type KMS interface {
	// Kind identifies the provider. Returns one of the Kind constants.
	Kind() Kind

	// Name is the human-friendly identifier from KMSProvider.Name —
	// used for log + audit fields.
	Name() string

	// EncryptDEK wraps the supplied plaintext DEK under the provider's
	// configured KEK. The plaintext DEK is treated as sensitive; the
	// caller wipes it after passing the wrapped result to storage.
	//
	// encryptionContext is provider-specific AAD passed verbatim where
	// supported (Vault, AWS, GCP). Providers that don't natively
	// support it ignore the parameter; the canonical AAD binding lives
	// in the envelope AEAD itself.
	EncryptDEK(ctx context.Context, plaintextDEK []byte, encryptionContext map[string]string) (*WrappedDEK, error)

	// DecryptDEK unwraps the supplied ciphertext to recover the
	// plaintext DEK. The keyID/keyVersion are read straight off the
	// envelope row that owns this ciphertext — providers should
	// validate them where the wire format allows it.
	DecryptDEK(ctx context.Context, ciphertext []byte, keyID string, keyVersion int, encryptionContext map[string]string) ([]byte, error)

	// Rewrap re-wraps the same DEK under the latest KEK version
	// without exposing the plaintext DEK to the caller. Providers
	// that expose a native rewrap RPC use it; the rest fall back to
	// Decrypt + Encrypt internally.
	//
	// The returned WrappedDEK replaces what was on the envelope row
	// after the rotation job commits.
	Rewrap(ctx context.Context, ciphertext []byte, keyID string, keyVersion int, encryptionContext map[string]string) (*WrappedDEK, error)

	// Healthcheck performs a minimal round-trip (typically wrap +
	// unwrap of a 32-byte stub) against the configured KEK and
	// returns nil on success. Used by /api/v1/setup/kms to verify a
	// freshly-saved provider config before marking it primary.
	Healthcheck(ctx context.Context) error
}

// Signer is an optional capability some KMS providers expose: produce and
// verify a detached signature over a caller-supplied digest. Used by the
// Phase 16 approval-ledger authenticated chain. The KMS interface
// intentionally does not require Sign — not every provider has a usable
// signing API (Azure Key Vault's sign is heavyweight, GCP requires a
// separate asymmetric key, etc.). Callers do a type assertion and fall
// back to hash-chain-only when Sign isn't available.
//
// Wire format
// -----------
// Sign returns provider-opaque bytes. The verifier must route a given
// signature to the SAME provider via KeyID (or whatever identifier the
// provider returns from SigningKeyID()). For Local that's the alias
// stored on the kms_providers row; for cloud providers it's the key ARN /
// resource path / Key Vault key ID.
type Signer interface {
	// Sign produces a detached signature over the digest. digest is
	// already SHA-256-sized for our use; providers that want to apply
	// their own hash treat this as the message bytes.
	Sign(ctx context.Context, digest []byte) (signature []byte, err error)
	// Verify checks a signature against the digest. Returns nil on
	// success. Implementations MUST validate the signature
	// cryptographically — never return nil unconditionally.
	Verify(ctx context.Context, digest, signature []byte) error
	// SigningKeyID returns the provider-side identifier of the signing
	// key. The approval ledger stores this alongside the signature so a
	// verifier can route to the correct key.
	SigningKeyID() string
}

// Errors returned by KMS implementations.
var (
	ErrUnknownKind        = errors.New("kms: unknown provider kind")
	ErrProviderDisabled   = errors.New("kms: provider disabled")
	ErrAuthMissing        = errors.New("kms: auth ciphertext missing or empty")
	ErrUnsealRequired     = errors.New("kms: gateway sealed — admin must unseal before KMS calls can succeed")
	ErrInvalidWiremessage = errors.New("kms: malformed wrapped DEK")
	ErrKeyVersionMismatch = errors.New("kms: stored key version differs from KMS response")
	ErrRewrapNotSupported = errors.New("kms: provider does not support rewrap")
	// ErrSignNotSupported is returned by Sign / Verify on providers that
	// haven't implemented the Signer capability. Callers should treat
	// it as "fall back to hash-chain-only" rather than failing the
	// surrounding operation.
	ErrSignNotSupported = errors.New("kms: provider does not support sign/verify")
)

// WrapError tags a provider-side error with its Kind so audit + logs can
// route blame back to the right system.
func WrapError(kind Kind, op string, err error) error {
	if err == nil {
		return nil
	}
	return fmt.Errorf("kms %s %s: %w", kind, op, err)
}
