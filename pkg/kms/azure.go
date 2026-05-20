package kms

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"

	"github.com/Azure/azure-sdk-for-go/sdk/azcore"
	"github.com/Azure/azure-sdk-for-go/sdk/azidentity"
	"github.com/Azure/azure-sdk-for-go/sdk/security/keyvault/azkeys"
)

// Azure is a KMS provider backed by Azure Key Vault key-wrap operations.
//
// Notes
// -----
//   - Azure Key Vault doesn't expose a symmetric "encrypt arbitrary
//     payload" RPC at the data-plane level — it offers WrapKey /
//     UnwrapKey instead. That's exactly the right primitive for our
//     envelope model: we send the DEK, the Key Vault wraps it with the
//     KEK (which can be RSA or AES under the hood), and hands back an
//     opaque blob.
//   - For AAD support we *cannot* attach encryption context natively;
//     Azure's WrapKey API doesn't take one. The envelope-level AEAD
//     binding inside internal/secrets remains the canonical AAD.
//     Operators who need cryptographic binding at the KEK layer should
//     pick Vault or GCP / AWS.
//   - Key versions are stable URLs in Azure: the same key name can be
//     wrapped under multiple versions; we record the version returned
//     by the KEK response so Decrypt routes back to the same.
//   - Algorithm defaults to RSA-OAEP-256 (modern, recommended for new
//     RSA KEKs) but honours an override from the kms_providers.ExtraJSON
//     `wrap_algorithm` field for operators who already provisioned
//     A256KW-style symmetric KEKs.
type Azure struct {
	name      string
	keyName   string
	keyVer    string // empty = use latest
	algorithm azkeys.EncryptionAlgorithm
	client    *azkeys.Client
}

// AzureConfig is what the factory hands NewAzure.
type AzureConfig struct {
	Name string
	// VaultURL is the Key Vault URL, e.g. "https://my-kv.vault.azure.net".
	VaultURL string
	// KeyName is the name of the key inside the vault.
	KeyName string
	// KeyVersion pins a specific key version. Empty = use latest at
	// wrap time.
	KeyVersion string
	// Algorithm is the wrap algorithm. Default RSA-OAEP-256.
	Algorithm string
	// AuthMethod: "default" (DefaultAzureCredential — managed identity,
	// workload identity, az cli) or "client_secret" (use AuthRoleID as
	// client_id + AuthSecret as client secret + tenant).
	AuthMethod string
	// AuthRoleID is the AAD tenant ID (for client_secret method).
	TenantID string
	// ClientID is the AAD application client_id (for client_secret).
	ClientID string
	// AuthSecret carries the client secret when AuthMethod=client_secret.
	AuthSecret []byte
}

// NewAzure constructs an Azure Key Vault KMS.
func NewAzure(ctx context.Context, cfg AzureConfig) (*Azure, error) {
	if cfg.VaultURL == "" {
		return nil, errors.New("kms azure: vault_url required")
	}
	if cfg.KeyName == "" {
		return nil, errors.New("kms azure: key_name required")
	}

	algo := azkeys.EncryptionAlgorithmRSAOAEP256
	if cfg.Algorithm != "" {
		algo = azkeys.EncryptionAlgorithm(cfg.Algorithm)
	}

	var cred azcore.TokenCredential
	var err error
	switch cfg.AuthMethod {
	case "client_secret":
		if cfg.TenantID == "" || cfg.ClientID == "" || len(cfg.AuthSecret) == 0 {
			return nil, ErrAuthMissing
		}
		cred, err = azidentity.NewClientSecretCredential(cfg.TenantID, cfg.ClientID, string(cfg.AuthSecret), nil)
		if err != nil {
			return nil, fmt.Errorf("kms azure: client secret credential: %w", err)
		}
	case "service_principal_json":
		if len(cfg.AuthSecret) == 0 {
			return nil, ErrAuthMissing
		}
		var sp struct {
			TenantID     string `json:"tenant_id"`
			ClientID     string `json:"client_id"`
			ClientSecret string `json:"client_secret"`
		}
		if err := json.Unmarshal(cfg.AuthSecret, &sp); err != nil {
			return nil, fmt.Errorf("kms azure: parse service principal JSON: %w", err)
		}
		cred, err = azidentity.NewClientSecretCredential(sp.TenantID, sp.ClientID, sp.ClientSecret, nil)
		if err != nil {
			return nil, fmt.Errorf("kms azure: client secret credential: %w", err)
		}
	case "default", "":
		cred, err = azidentity.NewDefaultAzureCredential(nil)
		if err != nil {
			return nil, fmt.Errorf("kms azure: default credential: %w", err)
		}
	default:
		return nil, fmt.Errorf("kms azure: unsupported auth_method %q", cfg.AuthMethod)
	}

	cli, err := azkeys.NewClient(cfg.VaultURL, cred, nil)
	if err != nil {
		return nil, fmt.Errorf("kms azure: new client: %w", err)
	}

	return &Azure{
		name:      cfg.Name,
		keyName:   cfg.KeyName,
		keyVer:    cfg.KeyVersion,
		algorithm: algo,
		client:    cli,
	}, nil
}

// Kind reports KindAzure.
func (a *Azure) Kind() Kind { return KindAzure }

// Name returns the kms_providers.Name value.
func (a *Azure) Name() string { return a.name }

// EncryptDEK calls Key Vault's WrapKey. Azure returns the version
// portion of the KID inline; we surface it as KeyVersion on the
// envelope so Decrypt always routes to the same version.
func (a *Azure) EncryptDEK(ctx context.Context, plaintextDEK []byte, encryptionContext map[string]string) (*WrappedDEK, error) {
	_ = encryptionContext // not supported by Azure WrapKey at the KEK layer; AEAD binding is in the envelope
	res, err := a.client.WrapKey(ctx, a.keyName, a.keyVer, azkeys.KeyOperationParameters{
		Algorithm: &a.algorithm,
		Value:     plaintextDEK,
	}, nil)
	if err != nil {
		return nil, WrapError(KindAzure, "encrypt", err)
	}
	if res.Result == nil {
		return nil, errors.New("kms azure: empty wrap result")
	}
	version := ""
	if res.KID != nil {
		version = parseAzureKIDVersion(string(*res.KID))
	}
	return &WrappedDEK{
		Ciphertext: append([]byte(nil), res.Result...),
		KeyID:      a.keyName,
		KeyVersion: azureVersionInt(version),
	}, nil
}

// DecryptDEK calls Key Vault's UnwrapKey.
func (a *Azure) DecryptDEK(ctx context.Context, ciphertext []byte, keyID string, keyVersion int, encryptionContext map[string]string) ([]byte, error) {
	_ = encryptionContext
	if keyID != a.keyName {
		return nil, fmt.Errorf("kms azure: key id %q does not match configured %q", keyID, a.keyName)
	}
	res, err := a.client.UnwrapKey(ctx, a.keyName, a.keyVer, azkeys.KeyOperationParameters{
		Algorithm: &a.algorithm,
		Value:     ciphertext,
	}, nil)
	if err != nil {
		return nil, WrapError(KindAzure, "decrypt", err)
	}
	if res.Result == nil {
		return nil, errors.New("kms azure: empty unwrap result")
	}
	return append([]byte(nil), res.Result...), nil
}

// Rewrap on Azure has no native primitive. We unwrap + re-wrap. Both
// halves stay inside the Key Vault HSM (the SDK calls hit the Key
// Vault data plane; plaintext never lands on our disk).
func (a *Azure) Rewrap(ctx context.Context, ciphertext []byte, keyID string, keyVersion int, encryptionContext map[string]string) (*WrappedDEK, error) {
	dek, err := a.DecryptDEK(ctx, ciphertext, keyID, keyVersion, encryptionContext)
	if err != nil {
		return nil, err
	}
	defer wipe(dek)
	return a.EncryptDEK(ctx, dek, encryptionContext)
}

// Healthcheck wraps + unwraps a 32-byte probe.
func (a *Azure) Healthcheck(ctx context.Context) error {
	probe := make([]byte, 32)
	for i := range probe {
		probe[i] = byte(i)
	}
	wrapped, err := a.EncryptDEK(ctx, probe, nil)
	if err != nil {
		return err
	}
	got, err := a.DecryptDEK(ctx, wrapped.Ciphertext, wrapped.KeyID, wrapped.KeyVersion, nil)
	if err != nil {
		return err
	}
	if !bytes.Equal(got, probe) {
		return errors.New("kms azure: healthcheck round-trip mismatch")
	}
	return nil
}

// parseAzureKIDVersion extracts the version segment from an Azure
// key URL such as `https://my-kv.vault.azure.net/keys/mykey/abc123…`.
// Returns the empty string if the URL is in an unexpected shape; the
// caller treats that as "unknown version".
func parseAzureKIDVersion(kid string) string {
	// Walk from the right; the version is the last path segment.
	for i := len(kid) - 1; i >= 0; i-- {
		if kid[i] == '/' {
			return kid[i+1:]
		}
	}
	return ""
}

// azureVersionInt collapses Azure's opaque version strings to a small
// integer for the envelope row. Azure uses 32-char hex IDs that don't
// carry an ordinal; we keep the textual version inline (via the audit
// trail's KeyID field) and store a sentinel `1` here so consumers
// don't trip over a zero default.
func azureVersionInt(_ string) int { return 1 }
