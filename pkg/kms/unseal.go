package kms

import (
	"crypto/cipher"
	"crypto/rand"
	"crypto/subtle"
	"encoding/binary"
	"errors"
	"fmt"
	"io"

	"golang.org/x/crypto/argon2"

	pkgcrypto "github.com/michongs/wayfort/pkg/crypto"
)

// Unsealer turns a bootstrap passphrase into the symmetric key that
// wraps KMSProvider.AuthCiphertext. The unsealer is the only place that
// reads the operator's bootstrap passphrase (from `var/keystore.unseal`)
// and the only thing standing between a DB dump + the KMS auth
// credentials.
//
// Design choices
// --------------
//   - Argon2id with t=4, m=64MiB, p=4 — current OWASP-mid-range against
//     a single-core 2024 box, comfortably tunable upward later.
//   - 16-byte salt persisted in kms_seal_material (same row as the
//     verifier). The salt is not secret; its job is keying isolation.
//   - The unseal passphrase NEVER reaches a Go variable that outlives
//     this call. Argon2id eats it, the derived key is held, the input
//     bytes go straight into the GC sweep.
//   - The derived key is held by the gateway process for the lifetime
//     of the unsealed boot. Sealed-on-restart is acceptable — the
//     operator re-supplies the passphrase, and we re-derive.
type Unsealer struct {
	derivedKey []byte // 32 bytes — AES-256
}

// Argon2id parameters. These are written into the seal material on
// first install so future param bumps don't break existing deployments.
// Bumping them requires re-keying.
const (
	argonTime    = 4
	argonMemKB   = 64 * 1024
	argonThreads = 4
	argonKeyLen  = 32
	saltLen      = 16
)

// DeriveUnsealer turns a passphrase + salt into an Unsealer. The
// passphrase is sourced from the file the operator placed at
// `var/keystore.unseal` (0600). On success the caller is expected to
// keep the returned Unsealer alive for the lifetime of the process.
func DeriveUnsealer(passphrase, salt []byte) *Unsealer {
	dk := argon2.IDKey(passphrase, salt, argonTime, argonMemKB, argonThreads, argonKeyLen)
	return &Unsealer{derivedKey: dk}
}

// NewSeal mints a brand-new (salt, verifier) pair from the supplied
// passphrase. The verifier is just argon2id(passphrase, salt) — we
// constant-time compare it on subsequent boots.
//
// Used once during initial setup.
func NewSeal(passphrase []byte) (salt, verifier []byte, err error) {
	salt = make([]byte, saltLen)
	if _, err := io.ReadFull(rand.Reader, salt); err != nil {
		return nil, nil, fmt.Errorf("read salt: %w", err)
	}
	verifier = argon2.IDKey(passphrase, salt, argonTime, argonMemKB, argonThreads, argonKeyLen)
	return salt, verifier, nil
}

// Verify checks the supplied passphrase against the stored
// (salt, verifier) pair. Returns nil on match, ErrUnsealRejected
// otherwise.
func Verify(passphrase, salt, verifier []byte) error {
	got := argon2.IDKey(passphrase, salt, argonTime, argonMemKB, argonThreads, argonKeyLen)
	if subtle.ConstantTimeCompare(got, verifier) != 1 {
		return ErrUnsealRejected
	}
	return nil
}

// ErrUnsealRejected is returned by Verify when the supplied passphrase
// does not match the stored verifier. The error message is intentionally
// vague — we don't want to leak whether the salt is right but the
// passphrase wrong.
var ErrUnsealRejected = errors.New("kms: unseal passphrase rejected")

// Seal encrypts the supplied plaintext under the unsealer's derived
// key. The result format is:
//
//   [1-byte version=0x01][12-byte nonce][AES-256-GCM ciphertext+tag]
//
// Total overhead 29 bytes. Used to wrap KMSProvider.AuthCiphertext +
// the Local-KMS KEK.
func (u *Unsealer) Seal(plaintext []byte) ([]byte, error) {
	gcm, err := pkgcrypto.NewAESGCM(u.derivedKey)
	if err != nil {
		return nil, err
	}
	nonce, err := pkgcrypto.RandomBytes(gcm.NonceSize())
	if err != nil {
		return nil, err
	}
	out := make([]byte, 0, 1+len(nonce)+len(plaintext)+gcm.Overhead())
	out = append(out, 0x01)
	out = append(out, nonce...)
	out = gcm.Seal(out, nonce, plaintext, nil)
	return out, nil
}

// Open is the inverse of Seal.
func (u *Unsealer) Open(sealed []byte) ([]byte, error) {
	if len(sealed) < 1 {
		return nil, ErrInvalidWiremessage
	}
	if sealed[0] != 0x01 {
		return nil, fmt.Errorf("kms: unknown seal version 0x%02x", sealed[0])
	}
	gcm, err := pkgcrypto.NewAESGCM(u.derivedKey)
	if err != nil {
		return nil, err
	}
	ns := gcm.NonceSize()
	if len(sealed) < 1+ns+gcm.Overhead() {
		return nil, ErrInvalidWiremessage
	}
	nonce := sealed[1 : 1+ns]
	ct := sealed[1+ns:]
	return gcm.Open(nil, nonce, ct, nil)
}

// AEAD exposes the raw AES-256-GCM block constructed from the derived
// key. Internal helpers can use it directly when they need to control
// the nonce / AAD themselves.
func (u *Unsealer) AEAD() (cipher.AEAD, error) {
	return pkgcrypto.NewAESGCM(u.derivedKey)
}

// PackUint32 / UnpackUint32 are tiny helpers used by the Local KMS
// when laying out its KEK blob.
func PackUint32(v uint32) []byte {
	b := make([]byte, 4)
	binary.BigEndian.PutUint32(b, v)
	return b
}

func UnpackUint32(b []byte) (uint32, error) {
	if len(b) != 4 {
		return 0, fmt.Errorf("kms: expected 4 bytes, got %d", len(b))
	}
	return binary.BigEndian.Uint32(b), nil
}
