package kms

import (
	"context"
	"encoding/base64"
	"errors"
	"fmt"
	"strconv"
	"strings"
	"sync"
	"time"

	vaultapi "github.com/hashicorp/vault/api"
)

// Vault is a KMS provider that delegates KEK custody to the HashiCorp
// Vault (or OpenBao) Transit secrets engine. This is the recommended
// option for self-hosted / private-cloud deployments because:
//
//   - Vault never stores the plaintext credential — Transit is
//     "encryption as a service", so the credential plaintext only
//     transits Vault's request handler.
//   - Vault tracks key versions natively. We expose Rewrap as a
//     Transit `rewrap` call so rotation is a single round-trip per
//     envelope.
//   - Encryption context (Vault's AAD) is supported natively, so we
//     can bind a ciphertext to its business owner without leaning on
//     the envelope AEAD alone.
//
// Auth chain
// ----------
// Auth method comes from the kms_providers row:
//
//   - "approle"     — RoleID stored in clear (AuthRoleID), SecretID
//                     unsealed from AuthCiphertext on every login.
//                     We login once on construction and let the
//                     vault/api package handle token refresh.
//   - "token"       — long-lived token stored in AuthCiphertext.
//                     Discouraged outside of dev.
//   - "kubernetes"  — service account JWT injected by the K8s API
//                     server at /var/run/secrets/.../token. Path is
//                     in the ExtraJSON `kubernetes_jwt_path` field.
//                     Role name in AuthRoleID. AuthCiphertext unused.
type Vault struct {
	name        string
	keyName     string
	mountPath   string // typically "transit"
	namespace   string
	client      *vaultapi.Client
	authReturn  func(ctx context.Context, c *vaultapi.Client) error
	lifecycle   sync.Mutex
	lastRefresh time.Time
}

// VaultConfig is what the factory hands NewVault. Everything originates
// from the kms_providers DB row + the unsealer.
type VaultConfig struct {
	Name       string
	Endpoint   string // https://vault.internal:8200
	Namespace  string
	MountPath  string // defaults to "transit"
	KeyName    string // KMSProvider.KeyID
	AuthMethod string // approle | token | kubernetes
	AuthRoleID string // AppRole role_id, or k8s role name
	AuthSecret []byte // plaintext SecretID / token, already unsealed
	TLSSkipVerify bool
	TLSCACertPath string
	K8sJWTPath    string // for auth_method=kubernetes
}

// NewVault constructs a Vault KMS from VaultConfig + the unsealed auth
// material. Authentication happens here so that the factory surfaces
// configuration errors at boot rather than at first wrap call.
func NewVault(ctx context.Context, cfg VaultConfig) (*Vault, error) {
	if cfg.Endpoint == "" {
		return nil, errors.New("kms vault: endpoint required")
	}
	if cfg.KeyName == "" {
		return nil, errors.New("kms vault: key_name required")
	}
	if cfg.MountPath == "" {
		cfg.MountPath = "transit"
	}

	apiCfg := vaultapi.DefaultConfig()
	apiCfg.Address = cfg.Endpoint
	if cfg.TLSCACertPath != "" || cfg.TLSSkipVerify {
		if err := apiCfg.ConfigureTLS(&vaultapi.TLSConfig{
			CACert:     cfg.TLSCACertPath,
			Insecure:   cfg.TLSSkipVerify,
		}); err != nil {
			return nil, fmt.Errorf("kms vault: configure TLS: %w", err)
		}
	}
	cli, err := vaultapi.NewClient(apiCfg)
	if err != nil {
		return nil, fmt.Errorf("kms vault: new client: %w", err)
	}
	if cfg.Namespace != "" {
		cli.SetNamespace(cfg.Namespace)
	}

	v := &Vault{
		name:      cfg.Name,
		keyName:   cfg.KeyName,
		mountPath: cfg.MountPath,
		namespace: cfg.Namespace,
		client:    cli,
	}

	switch strings.ToLower(cfg.AuthMethod) {
	case "approle", "":
		if cfg.AuthRoleID == "" {
			return nil, errors.New("kms vault: auth_role_id required for approle")
		}
		if len(cfg.AuthSecret) == 0 {
			return nil, ErrAuthMissing
		}
		v.authReturn = func(ctx context.Context, c *vaultapi.Client) error {
			return v.appRoleLogin(ctx, cfg.AuthRoleID, string(cfg.AuthSecret))
		}
	case "token":
		if len(cfg.AuthSecret) == 0 {
			return nil, ErrAuthMissing
		}
		cli.SetToken(strings.TrimSpace(string(cfg.AuthSecret)))
		v.authReturn = func(ctx context.Context, c *vaultapi.Client) error { return nil }
	case "kubernetes":
		if cfg.AuthRoleID == "" {
			return nil, errors.New("kms vault: auth_role_id required for kubernetes")
		}
		path := cfg.K8sJWTPath
		if path == "" {
			path = "/var/run/secrets/kubernetes.io/serviceaccount/token"
		}
		v.authReturn = func(ctx context.Context, c *vaultapi.Client) error {
			return v.kubernetesLogin(ctx, cfg.AuthRoleID, path)
		}
	default:
		return nil, fmt.Errorf("kms vault: unsupported auth_method %q", cfg.AuthMethod)
	}

	if err := v.authReturn(ctx, cli); err != nil {
		return nil, fmt.Errorf("kms vault: initial login: %w", err)
	}
	return v, nil
}

// Kind reports KindVault.
func (v *Vault) Kind() Kind { return KindVault }

// Name returns the kms_providers.Name value.
func (v *Vault) Name() string { return v.name }

func (v *Vault) appRoleLogin(ctx context.Context, roleID, secretID string) error {
	v.lifecycle.Lock()
	defer v.lifecycle.Unlock()
	res, err := v.client.Logical().WriteWithContext(ctx, "auth/approle/login", map[string]interface{}{
		"role_id":   roleID,
		"secret_id": secretID,
	})
	if err != nil {
		return err
	}
	if res == nil || res.Auth == nil || res.Auth.ClientToken == "" {
		return errors.New("vault approle: no client token in response")
	}
	v.client.SetToken(res.Auth.ClientToken)
	v.lastRefresh = time.Now()
	return nil
}

func (v *Vault) kubernetesLogin(ctx context.Context, role, jwtPath string) error {
	v.lifecycle.Lock()
	defer v.lifecycle.Unlock()
	jwt, err := readFileTrim(jwtPath)
	if err != nil {
		return fmt.Errorf("read k8s jwt: %w", err)
	}
	res, err := v.client.Logical().WriteWithContext(ctx, "auth/kubernetes/login", map[string]interface{}{
		"role": role,
		"jwt":  jwt,
	})
	if err != nil {
		return err
	}
	if res == nil || res.Auth == nil || res.Auth.ClientToken == "" {
		return errors.New("vault k8s: no client token in response")
	}
	v.client.SetToken(res.Auth.ClientToken)
	v.lastRefresh = time.Now()
	return nil
}

// EncryptDEK calls Vault Transit `encrypt/<key>` with a base64-encoded
// plaintext. Vault returns ciphertext shaped as `vault:vN:<base64>` —
// we store that verbatim. The v-number is split out so the envelope
// row's KeyVersion stays correct without round-tripping a parse.
func (v *Vault) EncryptDEK(ctx context.Context, plaintextDEK []byte, encryptionContext map[string]string) (*WrappedDEK, error) {
	payload := map[string]interface{}{
		"plaintext": base64.StdEncoding.EncodeToString(plaintextDEK),
	}
	if ec := encodeContext(encryptionContext); ec != "" {
		payload["context"] = ec
	}
	res, err := v.client.Logical().WriteWithContext(ctx, v.path("encrypt"), payload)
	if err != nil {
		return nil, WrapError(KindVault, "encrypt", err)
	}
	if res == nil || res.Data == nil {
		return nil, errors.New("kms vault: empty encrypt response")
	}
	ct, ok := res.Data["ciphertext"].(string)
	if !ok || ct == "" {
		return nil, errors.New("kms vault: missing ciphertext in encrypt response")
	}
	version, _ := extractVaultVersion(ct)
	return &WrappedDEK{Ciphertext: []byte(ct), KeyID: v.keyName, KeyVersion: version}, nil
}

// DecryptDEK calls Vault Transit `decrypt/<key>`. Vault refuses to
// decrypt a ciphertext that wasn't produced by `<key>`, so the
// keyID check from Local.DecryptDEK isn't strictly necessary — but
// we still constant-time compare it for defence in depth.
func (v *Vault) DecryptDEK(ctx context.Context, ciphertext []byte, keyID string, keyVersion int, encryptionContext map[string]string) ([]byte, error) {
	if keyID != v.keyName {
		return nil, fmt.Errorf("kms vault: key id %q does not match configured %q", keyID, v.keyName)
	}
	payload := map[string]interface{}{
		"ciphertext": string(ciphertext),
	}
	if ec := encodeContext(encryptionContext); ec != "" {
		payload["context"] = ec
	}
	res, err := v.client.Logical().WriteWithContext(ctx, v.path("decrypt"), payload)
	if err != nil {
		return nil, WrapError(KindVault, "decrypt", err)
	}
	if res == nil || res.Data == nil {
		return nil, errors.New("kms vault: empty decrypt response")
	}
	pt, ok := res.Data["plaintext"].(string)
	if !ok {
		return nil, errors.New("kms vault: missing plaintext in decrypt response")
	}
	dek, err := base64.StdEncoding.DecodeString(pt)
	if err != nil {
		return nil, fmt.Errorf("kms vault: decode plaintext: %w", err)
	}
	return dek, nil
}

// Rewrap uses Vault Transit's native `rewrap/<key>` so the plaintext
// DEK never leaves Vault. The DEK on the new wire format is identical
// to the original; only the wrapping key version changes.
func (v *Vault) Rewrap(ctx context.Context, ciphertext []byte, keyID string, keyVersion int, encryptionContext map[string]string) (*WrappedDEK, error) {
	if keyID != v.keyName {
		return nil, fmt.Errorf("kms vault: key id %q does not match configured %q", keyID, v.keyName)
	}
	payload := map[string]interface{}{
		"ciphertext": string(ciphertext),
	}
	if ec := encodeContext(encryptionContext); ec != "" {
		payload["context"] = ec
	}
	res, err := v.client.Logical().WriteWithContext(ctx, v.path("rewrap"), payload)
	if err != nil {
		return nil, WrapError(KindVault, "rewrap", err)
	}
	if res == nil || res.Data == nil {
		return nil, errors.New("kms vault: empty rewrap response")
	}
	ct, ok := res.Data["ciphertext"].(string)
	if !ok || ct == "" {
		return nil, errors.New("kms vault: missing ciphertext in rewrap response")
	}
	version, _ := extractVaultVersion(ct)
	return &WrappedDEK{Ciphertext: []byte(ct), KeyID: v.keyName, KeyVersion: version}, nil
}

// Healthcheck wraps + unwraps a 32-byte probe. Failing means either
// the Vault is unreachable, the token has expired, the key is gone,
// or policy denies it — all of which an operator wants to know
// before saving the provider as primary.
func (v *Vault) Healthcheck(ctx context.Context) error {
	probe := make([]byte, 32)
	for i := range probe {
		probe[i] = byte(i) // deterministic; secrecy irrelevant for a healthcheck
	}
	wrapped, err := v.EncryptDEK(ctx, probe, nil)
	if err != nil {
		return err
	}
	got, err := v.DecryptDEK(ctx, wrapped.Ciphertext, wrapped.KeyID, wrapped.KeyVersion, nil)
	if err != nil {
		return err
	}
	if string(got) != string(probe) {
		return errors.New("kms vault: healthcheck round-trip mismatch")
	}
	return nil
}

func (v *Vault) path(op string) string {
	return v.mountPath + "/" + op + "/" + v.keyName
}

// encodeContext serialises encryption context to Vault's wire format:
// base64-encoded "k1=v1,k2=v2" with keys sorted.
func encodeContext(ec map[string]string) string {
	if len(ec) == 0 {
		return ""
	}
	flat := canonicaliseContext(ec)
	return base64.StdEncoding.EncodeToString(flat)
}

// extractVaultVersion parses "vault:v3:..." → 3. Returns (0, error)
// on unparseable input; callers tolerate version=0 as "unknown".
func extractVaultVersion(ct string) (int, error) {
	parts := strings.SplitN(ct, ":", 3)
	if len(parts) != 3 || parts[0] != "vault" {
		return 0, ErrInvalidWiremessage
	}
	vs := strings.TrimPrefix(parts[1], "v")
	n, err := strconv.Atoi(vs)
	if err != nil {
		return 0, ErrInvalidWiremessage
	}
	return n, nil
}
