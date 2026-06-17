package desktop

import (
	"crypto/rand"
	"crypto/rsa"
	"crypto/x509"
	"encoding/pem"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"sync"
	"time"

	"github.com/golang-jwt/jwt/v5"
)

// JWTSigner mints short-lived RS256 JWTs that Devolutions Gateway will
// validate before opening a backend RDP TCP connection. The private key
// lives on this gateway; the matching public key is written to the
// Devolutions Gateway config as `ProvisionerPublicKeyFile`. RS256 (RSA
// PKCS#1 v1.5 SHA-256) is what Devolutions Gateway documents and what
// their RDM product uses in production, so interop is well exercised.
//
// First-run experience: if PrivateKeyPath does not exist, NewJWTSigner
// generates a fresh 2048-bit RSA keypair, writes the private key with
// 0600 permissions, and writes the public key next to it at the same
// path with a `.pub` suffix (PKIX/SPKI PEM, which is what Devolutions
// Gateway expects per their cookbook). No human key management step is
// required to bring up a fresh gateway.
type JWTSigner struct {
	privatePath string
	publicPath  string

	mu  sync.RWMutex
	key *rsa.PrivateKey
}

// NewJWTSigner loads (or, on first run, generates and persists) the
// RSA keypair under privatePath. The public key path is derived as
// `<privatePath>.pub` — callers should wire that path into the
// Devolutions Gateway config they generate.
func NewJWTSigner(privatePath string) (*JWTSigner, error) {
	if privatePath == "" {
		return nil, errors.New("jwt_signer: private key path is required")
	}
	pubPath := privatePath + ".pub"
	s := &JWTSigner{privatePath: privatePath, publicPath: pubPath}
	if err := s.loadOrGenerate(); err != nil {
		return nil, err
	}
	return s, nil
}

// PublicKeyPath returns the on-disk path of the public key the Devolutions
// Gateway config must reference under `ProvisionerPublicKeyFile`.
func (s *JWTSigner) PublicKeyPath() string { return s.publicPath }

// DevolutionsClaims is the JWT body Devolutions Gateway expects for the
// "forward an RDP TCP connection" use case. See:
//   https://github.com/Devolutions/devolutions-gateway/blob/master/docs/COOKBOOK.md
//
// jet_cm="fwd" + jet_ap="rdp" tells the gateway to byte-proxy a WebSocket
// → TCP tunnel to dst_hst. The `nbf` / `exp` window is intentionally
// narrow (about a minute) so a token leak has tiny blast radius — the
// browser only needs the token long enough to open one WebSocket.
type DevolutionsClaims struct {
	JTI   string `json:"jti"`
	JetCM string `json:"jet_cm"`
	JetAP string `json:"jet_ap"`
	DstH  string `json:"dst_hst"`
	jwt.RegisteredClaims
}

// SignForwardRDP returns a signed RS256 JWT authorising a single
// browser WebSocket to be tunnelled to `dst` (a "host:port" string).
// TTL clamped to a tight window — see DevolutionsClaims rationale.
func (s *JWTSigner) SignForwardRDP(dst string, ttl time.Duration) (string, error) {
	if dst == "" {
		return "", errors.New("jwt_signer: dst is required")
	}
	if ttl <= 0 {
		ttl = 90 * time.Second
	}
	now := time.Now()
	claims := DevolutionsClaims{
		JTI:   newUUIDv4(),
		JetCM: "fwd",
		JetAP: "rdp",
		DstH:  dst,
		RegisteredClaims: jwt.RegisteredClaims{
			Issuer:    "wayfort",
			IssuedAt:  jwt.NewNumericDate(now),
			NotBefore: jwt.NewNumericDate(now.Add(-5 * time.Second)),
			ExpiresAt: jwt.NewNumericDate(now.Add(ttl)),
		},
	}
	s.mu.RLock()
	defer s.mu.RUnlock()
	if s.key == nil {
		return "", errors.New("jwt_signer: key not loaded")
	}
	token := jwt.NewWithClaims(jwt.SigningMethodRS256, claims)
	return token.SignedString(s.key)
}

func (s *JWTSigner) loadOrGenerate() error {
	pem, err := os.ReadFile(s.privatePath)
	if err == nil {
		key, perr := parseRSAPrivatePEM(pem)
		if perr != nil {
			return fmt.Errorf("jwt_signer: parse %s: %w", s.privatePath, perr)
		}
		s.mu.Lock()
		s.key = key
		s.mu.Unlock()
		// Make sure the matching public key file exists. If it doesn't
		// (e.g. operator hand-copied the private half), regenerate the
		// public side from the private key so Devolutions Gateway's
		// config has something to load.
		return s.ensurePublicKeyFile()
	}
	if !os.IsNotExist(err) {
		return fmt.Errorf("jwt_signer: read %s: %w", s.privatePath, err)
	}
	if err := os.MkdirAll(filepath.Dir(s.privatePath), 0o700); err != nil {
		return fmt.Errorf("jwt_signer: mkdir %s: %w", filepath.Dir(s.privatePath), err)
	}
	key, err := rsa.GenerateKey(rand.Reader, 2048)
	if err != nil {
		return fmt.Errorf("jwt_signer: generate rsa key: %w", err)
	}
	if err := writePEMFile(s.privatePath, "RSA PRIVATE KEY", x509.MarshalPKCS1PrivateKey(key), 0o600); err != nil {
		return err
	}
	s.mu.Lock()
	s.key = key
	s.mu.Unlock()
	return s.ensurePublicKeyFile()
}

func (s *JWTSigner) ensurePublicKeyFile() error {
	if _, err := os.Stat(s.publicPath); err == nil {
		return nil
	} else if !os.IsNotExist(err) {
		return fmt.Errorf("jwt_signer: stat %s: %w", s.publicPath, err)
	}
	s.mu.RLock()
	pub := &s.key.PublicKey
	s.mu.RUnlock()
	der, err := x509.MarshalPKIXPublicKey(pub)
	if err != nil {
		return fmt.Errorf("jwt_signer: marshal public key: %w", err)
	}
	return writePEMFile(s.publicPath, "PUBLIC KEY", der, 0o644)
}

func parseRSAPrivatePEM(buf []byte) (*rsa.PrivateKey, error) {
	block, _ := pem.Decode(buf)
	if block == nil {
		return nil, errors.New("no PEM block found")
	}
	switch block.Type {
	case "RSA PRIVATE KEY":
		return x509.ParsePKCS1PrivateKey(block.Bytes)
	case "PRIVATE KEY":
		key, err := x509.ParsePKCS8PrivateKey(block.Bytes)
		if err != nil {
			return nil, err
		}
		rsaKey, ok := key.(*rsa.PrivateKey)
		if !ok {
			return nil, errors.New("PKCS8 key is not RSA")
		}
		return rsaKey, nil
	default:
		return nil, fmt.Errorf("unsupported PEM type %q (want RSA PRIVATE KEY or PRIVATE KEY)", block.Type)
	}
}

func writePEMFile(path, blockType string, der []byte, mode os.FileMode) error {
	f, err := os.OpenFile(path, os.O_WRONLY|os.O_CREATE|os.O_TRUNC, mode)
	if err != nil {
		return fmt.Errorf("jwt_signer: open %s: %w", path, err)
	}
	defer f.Close()
	return pem.Encode(f, &pem.Block{Type: blockType, Bytes: der})
}

// newUUIDv4 is an inline helper so jwt_signer.go doesn't depend on the
// uuid package (it's already pulled in via manager.go, but the import
// graph here is intentionally narrow).
func newUUIDv4() string {
	var b [16]byte
	_, _ = rand.Read(b[:])
	b[6] = (b[6] & 0x0f) | 0x40
	b[8] = (b[8] & 0x3f) | 0x80
	return fmt.Sprintf("%08x-%04x-%04x-%04x-%012x",
		b[0:4], b[4:6], b[6:8], b[8:10], b[10:16])
}
