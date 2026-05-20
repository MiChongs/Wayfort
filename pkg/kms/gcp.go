package kms

import (
	"bytes"
	"context"
	"errors"
	"fmt"

	gcpkms "cloud.google.com/go/kms/apiv1"
	"cloud.google.com/go/kms/apiv1/kmspb"
	"google.golang.org/api/option"
)

// GCP is a KMS provider backed by Google Cloud KMS.
//
// Notes
// -----
//   - GCP Cloud KMS exposes symmetric Encrypt / Decrypt at the data
//     plane, with AdditionalAuthenticatedData support — direct mapping
//     to our envelope model.
//   - Key version is part of the response (`Name` on the EncryptResponse
//     includes the cryptoKeyVersion path segment). We extract it for
//     the envelope KeyVersion. On Decrypt the Name field on the request
//     is the cryptoKey (no version) so GCP can route to whichever
//     version was used at encrypt time.
//   - Authentication flows through google.golang.org/api/option:
//
//       * "default"          → Application Default Credentials
//       * "service_account"  → JSON service account key in AuthSecret
//
//     The Phase 14 brief discourages env-var auth for the master key,
//     and GCP's ADC reads env vars (GOOGLE_APPLICATION_CREDENTIALS) by
//     default. Operators on Workload Identity / GCE metadata don't
//     touch env vars. For installations that must store the SA JSON,
//     `service_account` mode reads it from AuthCiphertext after the
//     bootstrap unseal.
type GCP struct {
	name    string
	keyPath string // projects/*/locations/*/keyRings/*/cryptoKeys/*
	client  *gcpkms.KeyManagementClient
}

// GCPConfig is what the factory hands NewGCP.
type GCPConfig struct {
	Name string
	// KeyPath is the full resource name of the cryptoKey:
	//   projects/foo/locations/us/keyRings/bar/cryptoKeys/jumpserver-creds
	KeyPath string
	// AuthMethod: "default" or "service_account".
	AuthMethod string
	// AuthSecret is the service account JSON (when AuthMethod=service_account).
	AuthSecret []byte
}

// NewGCP constructs a GCP Cloud KMS provider.
func NewGCP(ctx context.Context, cfg GCPConfig) (*GCP, error) {
	if cfg.KeyPath == "" {
		return nil, errors.New("kms gcp: key_path required")
	}

	var opts []option.ClientOption
	switch cfg.AuthMethod {
	case "service_account":
		if len(cfg.AuthSecret) == 0 {
			return nil, ErrAuthMissing
		}
		opts = append(opts, option.WithCredentialsJSON(cfg.AuthSecret))
	case "default", "":
		// Use Application Default Credentials.
	default:
		return nil, fmt.Errorf("kms gcp: unsupported auth_method %q", cfg.AuthMethod)
	}

	cli, err := gcpkms.NewKeyManagementClient(ctx, opts...)
	if err != nil {
		return nil, fmt.Errorf("kms gcp: new client: %w", err)
	}

	return &GCP{name: cfg.Name, keyPath: cfg.KeyPath, client: cli}, nil
}

// Kind reports KindGCP.
func (g *GCP) Kind() Kind { return KindGCP }

// Name returns the kms_providers.Name value.
func (g *GCP) Name() string { return g.name }

// EncryptDEK calls the GCP KMS Encrypt RPC.
func (g *GCP) EncryptDEK(ctx context.Context, plaintextDEK []byte, encryptionContext map[string]string) (*WrappedDEK, error) {
	aad := canonicaliseContext(encryptionContext)
	res, err := g.client.Encrypt(ctx, &kmspb.EncryptRequest{
		Name:                        g.keyPath,
		Plaintext:                   plaintextDEK,
		AdditionalAuthenticatedData: aad,
	})
	if err != nil {
		return nil, WrapError(KindGCP, "encrypt", err)
	}
	if res == nil || len(res.Ciphertext) == 0 {
		return nil, errors.New("kms gcp: empty ciphertext")
	}
	version := parseGCPKeyVersion(res.Name)
	return &WrappedDEK{
		Ciphertext: append([]byte(nil), res.Ciphertext...),
		KeyID:      g.keyPath,
		KeyVersion: version,
	}, nil
}

// DecryptDEK calls the GCP KMS Decrypt RPC.
func (g *GCP) DecryptDEK(ctx context.Context, ciphertext []byte, keyID string, keyVersion int, encryptionContext map[string]string) ([]byte, error) {
	if keyID != g.keyPath {
		return nil, fmt.Errorf("kms gcp: key path %q does not match configured %q", keyID, g.keyPath)
	}
	aad := canonicaliseContext(encryptionContext)
	res, err := g.client.Decrypt(ctx, &kmspb.DecryptRequest{
		Name:                        g.keyPath,
		Ciphertext:                  ciphertext,
		AdditionalAuthenticatedData: aad,
	})
	if err != nil {
		return nil, WrapError(KindGCP, "decrypt", err)
	}
	if res == nil || len(res.Plaintext) == 0 {
		return nil, errors.New("kms gcp: empty plaintext")
	}
	return append([]byte(nil), res.Plaintext...), nil
}

// Rewrap on GCP doesn't have a single native RPC. We Decrypt + Encrypt;
// both halves are inside the KMS HSM and the plaintext lives in our
// process for the few microseconds between calls. For environments
// that care, this can be moved to a key-version-targeting Encrypt that
// pins the new primary version explicitly.
func (g *GCP) Rewrap(ctx context.Context, ciphertext []byte, keyID string, keyVersion int, encryptionContext map[string]string) (*WrappedDEK, error) {
	dek, err := g.DecryptDEK(ctx, ciphertext, keyID, keyVersion, encryptionContext)
	if err != nil {
		return nil, err
	}
	defer wipe(dek)
	return g.EncryptDEK(ctx, dek, encryptionContext)
}

// Healthcheck wraps + unwraps a 32-byte probe.
func (g *GCP) Healthcheck(ctx context.Context) error {
	probe := make([]byte, 32)
	for i := range probe {
		probe[i] = byte(i)
	}
	wrapped, err := g.EncryptDEK(ctx, probe, nil)
	if err != nil {
		return err
	}
	got, err := g.DecryptDEK(ctx, wrapped.Ciphertext, wrapped.KeyID, wrapped.KeyVersion, nil)
	if err != nil {
		return err
	}
	if !bytes.Equal(got, probe) {
		return errors.New("kms gcp: healthcheck round-trip mismatch")
	}
	return nil
}

// parseGCPKeyVersion extracts the cryptoKeyVersion integer from a GCP
// resource name such as
//
//   projects/foo/locations/.../cryptoKeys/.../cryptoKeyVersions/3
//
// Returns 1 on unrecognised names — that matches GCP's default
// "primary version" semantics for fresh CMKs.
func parseGCPKeyVersion(name string) int {
	const prefix = "cryptoKeyVersions/"
	idx := -1
	for i := 0; i < len(name)-len(prefix); i++ {
		if name[i:i+len(prefix)] == prefix {
			idx = i + len(prefix)
			break
		}
	}
	if idx < 0 {
		return 1
	}
	n := 0
	for j := idx; j < len(name); j++ {
		c := name[j]
		if c < '0' || c > '9' {
			break
		}
		n = n*10 + int(c-'0')
	}
	if n == 0 {
		return 1
	}
	return n
}
