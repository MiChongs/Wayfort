package kms

import (
	"context"
	"crypto/ed25519"
	"crypto/sha256"
	"crypto/subtle"
	"fmt"
	"sort"
	"strings"

	pkgcrypto "github.com/michongs/jumpserver-anonymous/pkg/crypto"
	"golang.org/x/crypto/hkdf"
)

// Local is a KMS provider whose KEK lives in the application's own DB
// as kms_providers.AuthCiphertext, sealed under the operator's
// bootstrap passphrase. It exists for two purposes only:
//
//   1. Bootstrapping a fresh install before the operator has stood up
//      a real KMS. The setup wizard mints one of these automatically
//      so credential storage works from minute one.
//   2. Hermetic test deployments / development environments where a
//      real Vault / cloud KMS would be theatre.
//
// In every other case operators should switch to one of the external
// providers (Vault, AWS, Azure, GCP) and rotate envelopes to that
// provider's KEK via the rewrap job.
//
// Security caveats
// ----------------
// Because the KEK is recoverable to anyone who has (a) a DB dump AND
// (b) the bootstrap passphrase, this provider does NOT meet the bar
// laid out in the Phase 14 brief by itself. Treat it as an intermediate
// step, not a destination. The setup banner emits a warning whenever
// a Local provider stays primary for more than 7 days.
type Local struct {
	name    string
	keyID   string
	version int

	// kek is the unwrapped key material. 32 bytes (AES-256). Held for
	// the lifetime of the process; nil after Close() to make memory
	// inspection slightly harder.
	kek []byte
}

// NewLocal constructs a Local KMS from its kms_providers row. The
// caller is responsible for unsealing `sealedKEK` first — typically
// `unsealer.Open(row.AuthCiphertext)`.
func NewLocal(name, keyID string, kek []byte) (*Local, error) {
	if len(kek) != 32 {
		return nil, fmt.Errorf("kms local: KEK must be 32 bytes, got %d", len(kek))
	}
	return &Local{name: name, keyID: keyID, version: 1, kek: kek}, nil
}

// Kind returns KindLocal.
func (l *Local) Kind() Kind { return KindLocal }

// Name returns the kms_providers.Name value.
func (l *Local) Name() string { return l.name }

// EncryptDEK wraps the DEK with the KEK using AES-256-GCM. Wire format:
//
//   [1 byte = 0x01 version]
//   [12 byte = nonce]
//   [N bytes = AES-256-GCM(KEK, DEK, AAD=encryptionContext)]
//
// encryptionContext is serialised as `key=value;` pairs in lexicographic
// order. Same logic in DecryptDEK so a DEK encrypted with context
// {"a":"1","b":"2"} can only be opened with the identical context.
func (l *Local) EncryptDEK(ctx context.Context, plaintextDEK []byte, encryptionContext map[string]string) (*WrappedDEK, error) {
	gcm, err := pkgcrypto.NewAESGCM(l.kek)
	if err != nil {
		return nil, WrapError(KindLocal, "encrypt", err)
	}
	nonce, err := pkgcrypto.RandomBytes(gcm.NonceSize())
	if err != nil {
		return nil, WrapError(KindLocal, "encrypt", err)
	}
	aad := canonicaliseContext(encryptionContext)
	out := make([]byte, 0, 1+len(nonce)+len(plaintextDEK)+gcm.Overhead())
	out = append(out, 0x01)
	out = append(out, nonce...)
	out = gcm.Seal(out, nonce, plaintextDEK, aad)
	return &WrappedDEK{Ciphertext: out, KeyID: l.keyID, KeyVersion: l.version}, nil
}

// DecryptDEK is the inverse of EncryptDEK. Validates the supplied
// keyID against the configured one — the envelope row records which
// Local provider wrote its DEK, and routing a decrypt to the wrong
// provider here should fail loudly rather than producing garbage.
func (l *Local) DecryptDEK(ctx context.Context, ciphertext []byte, keyID string, keyVersion int, encryptionContext map[string]string) ([]byte, error) {
	if subtle.ConstantTimeCompare([]byte(keyID), []byte(l.keyID)) != 1 {
		return nil, fmt.Errorf("kms local: key id %q does not match configured %q", keyID, l.keyID)
	}
	if len(ciphertext) < 1 {
		return nil, ErrInvalidWiremessage
	}
	if ciphertext[0] != 0x01 {
		return nil, fmt.Errorf("kms local: unknown wire version 0x%02x", ciphertext[0])
	}
	gcm, err := pkgcrypto.NewAESGCM(l.kek)
	if err != nil {
		return nil, WrapError(KindLocal, "decrypt", err)
	}
	ns := gcm.NonceSize()
	if len(ciphertext) < 1+ns+gcm.Overhead() {
		return nil, ErrInvalidWiremessage
	}
	nonce := ciphertext[1 : 1+ns]
	ct := ciphertext[1+ns:]
	aad := canonicaliseContext(encryptionContext)
	plain, err := gcm.Open(nil, nonce, ct, aad)
	if err != nil {
		return nil, WrapError(KindLocal, "decrypt", err)
	}
	return plain, nil
}

// Rewrap for Local is a no-op (or rather, it produces a fresh
// wrap under the same KEK) because the Local provider has only ever
// one key version. We still go through Decrypt + Encrypt so the
// envelope row gets a fresh ciphertext — useful if someone wants to
// rotate the per-row DEK without leaving Local. To actually rotate
// the underlying KEK, operators switch to a non-Local provider.
func (l *Local) Rewrap(ctx context.Context, ciphertext []byte, keyID string, keyVersion int, encryptionContext map[string]string) (*WrappedDEK, error) {
	dek, err := l.DecryptDEK(ctx, ciphertext, keyID, keyVersion, encryptionContext)
	if err != nil {
		return nil, err
	}
	defer wipe(dek)
	return l.EncryptDEK(ctx, dek, encryptionContext)
}

// signingKey derives the Ed25519 seed from the KEK via HKDF-SHA256 so the
// signing key is cryptographically separate from the AEAD wrapping key
// even though they share the same root secret. Same KEK → same Ed25519
// keypair across process restarts, which is what we want: the ledger's
// authenticity check survives node restarts and replicas.
//
// Domain separator "approval.ledger.signing.v1" is deliberately stable —
// changing it would orphan every previously-signed event. Add a new
// version constant if a key rotation policy ever demands it.
func (l *Local) signingKey() ed25519.PrivateKey {
	const info = "approval.ledger.signing.v1"
	r := hkdf.New(sha256.New, l.kek, nil, []byte(info))
	seed := make([]byte, ed25519.SeedSize)
	_, _ = r.Read(seed)
	return ed25519.NewKeyFromSeed(seed)
}

// SigningKeyID returns the same alias as the wrapping key — the kms_providers
// row carries a single Name, and the ledger stores it so a future
// auditor can verify "this signature was produced by the provider
// identified as N".
func (l *Local) SigningKeyID() string { return l.keyID }

// Sign produces an Ed25519 signature over the supplied digest. The digest
// is already SHA-256-sized by the caller (the approval ledger feeds in
// event.Hash directly). Ed25519's PureEdDSA accepts arbitrary-length
// messages, so we sign the digest verbatim.
func (l *Local) Sign(_ context.Context, digest []byte) ([]byte, error) {
	if len(digest) == 0 {
		return nil, fmt.Errorf("kms local sign: empty digest")
	}
	pk := l.signingKey()
	defer wipe(pk[:ed25519.SeedSize])
	sig := ed25519.Sign(pk, digest)
	return sig, nil
}

// Verify checks the signature; nil = valid.
func (l *Local) Verify(_ context.Context, digest, signature []byte) error {
	if len(signature) != ed25519.SignatureSize {
		return fmt.Errorf("kms local verify: signature wrong length (%d != %d)",
			len(signature), ed25519.SignatureSize)
	}
	pk := l.signingKey()
	defer wipe(pk[:ed25519.SeedSize])
	pub := pk.Public().(ed25519.PublicKey)
	if !ed25519.Verify(pub, digest, signature) {
		return fmt.Errorf("kms local verify: signature does not match")
	}
	return nil
}

// Healthcheck wraps + unwraps a 32-byte sentinel DEK and verifies the
// round-trip. Cheap and conclusive.
func (l *Local) Healthcheck(ctx context.Context) error {
	probe, err := pkgcrypto.RandomBytes(32)
	if err != nil {
		return err
	}
	wrapped, err := l.EncryptDEK(ctx, probe, nil)
	if err != nil {
		return err
	}
	got, err := l.DecryptDEK(ctx, wrapped.Ciphertext, wrapped.KeyID, wrapped.KeyVersion, nil)
	if err != nil {
		return err
	}
	if subtle.ConstantTimeCompare(probe, got) != 1 {
		return fmt.Errorf("kms local: healthcheck round-trip produced different bytes")
	}
	return nil
}

// canonicaliseContext flattens a {key:value} AAD map into the byte
// sequence `k1=v1\x1fk2=v2\x1f…` with keys sorted lexicographically.
// AES-GCM treats AAD as opaque bytes; we just need a canonical
// representation so Encrypt + Decrypt on different goroutines agree.
//
// Reused by every KMS that lacks native EC support (Local, partial-
// Azure) and by the envelope service when computing AADHash.
func canonicaliseContext(ec map[string]string) []byte {
	if len(ec) == 0 {
		return nil
	}
	keys := make([]string, 0, len(ec))
	for k := range ec {
		keys = append(keys, k)
	}
	sort.Strings(keys)
	var b strings.Builder
	for i, k := range keys {
		if i > 0 {
			b.WriteByte(0x1f)
		}
		b.WriteString(k)
		b.WriteByte('=')
		b.WriteString(ec[k])
	}
	return []byte(b.String())
}

// wipe zeroes a byte slice. Best-effort — Go's GC may copy the slice
// before this runs, but it shortens the window plaintext DEKs sit in
// freeable memory.
func wipe(b []byte) {
	for i := range b {
		b[i] = 0
	}
}
