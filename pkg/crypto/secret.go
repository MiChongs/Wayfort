package crypto

import (
	"crypto/aes"
	"crypto/cipher"
	"crypto/rand"
	"encoding/hex"
	"fmt"
	"io"
)

// Sealer encrypts and decrypts small credential blobs with AES-256-GCM.
// The nonce is prepended to the ciphertext.
type Sealer struct {
	gcm cipher.AEAD
}

func NewSealer(masterKeyHex string) (*Sealer, error) {
	key, err := hex.DecodeString(masterKeyHex)
	if err != nil {
		return nil, fmt.Errorf("decode master key: %w", err)
	}
	if len(key) != 32 {
		return nil, fmt.Errorf("master key must be 32 bytes, got %d", len(key))
	}
	block, err := aes.NewCipher(key)
	if err != nil {
		return nil, err
	}
	gcm, err := cipher.NewGCM(block)
	if err != nil {
		return nil, err
	}
	return &Sealer{gcm: gcm}, nil
}

func (s *Sealer) Seal(plain []byte) ([]byte, error) {
	nonce := make([]byte, s.gcm.NonceSize())
	if _, err := io.ReadFull(rand.Reader, nonce); err != nil {
		return nil, err
	}
	out := s.gcm.Seal(nonce, nonce, plain, nil)
	return out, nil
}

func (s *Sealer) Open(sealed []byte) ([]byte, error) {
	ns := s.gcm.NonceSize()
	if len(sealed) < ns {
		return nil, fmt.Errorf("sealed blob too short")
	}
	nonce, ct := sealed[:ns], sealed[ns:]
	return s.gcm.Open(nil, nonce, ct, nil)
}
