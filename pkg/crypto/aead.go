package crypto

import (
	"crypto/aes"
	"crypto/cipher"
	"crypto/rand"
	"fmt"
	"io"
)

// NewAESGCM constructs an AES-256-GCM AEAD primitive from a raw 32-byte key.
// Used by internal/secrets when the algorithm field of an envelope row is
// "aes-256-gcm".
//
// The key MUST be 32 bytes. Callers are responsible for wiping it from
// memory after use; this function does not retain a reference.
func NewAESGCM(key []byte) (cipher.AEAD, error) {
	if len(key) != 32 {
		return nil, fmt.Errorf("aes-256-gcm key must be 32 bytes, got %d", len(key))
	}
	block, err := aes.NewCipher(key)
	if err != nil {
		return nil, err
	}
	return cipher.NewGCM(block)
}

// RandomBytes draws n cryptographically-secure random bytes from crypto/rand.
// Wrapper exists so unit tests in internal/secrets can inject a deterministic
// RNG without depending on crypto/rand's package-level Reader.
func RandomBytes(n int) ([]byte, error) {
	if n <= 0 {
		return nil, fmt.Errorf("RandomBytes: n must be positive, got %d", n)
	}
	buf := make([]byte, n)
	if _, err := io.ReadFull(rand.Reader, buf); err != nil {
		return nil, fmt.Errorf("read random bytes: %w", err)
	}
	return buf, nil
}

// GenerateDEK returns a fresh 32-byte AES-256 data encryption key. The DEK
// is intended for one-shot use: wrap a single credential plaintext, then
// the caller hands the DEK off to the KMS for KEK-wrapping and wipes it.
func GenerateDEK() ([]byte, error) {
	return RandomBytes(32)
}
