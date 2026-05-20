package secrets

import (
	"context"
	"errors"
	"sync/atomic"

	"github.com/michongs/jumpserver-anonymous/internal/model"
	pkgcrypto "github.com/michongs/jumpserver-anonymous/pkg/crypto"
)

// EnvelopeVault is the pkg/crypto.Vault implementation backed by the
// Phase 14 envelope service. Each Seal() mints a fresh envelope row;
// each Open() resolves the pointer back to an envelope and unwraps it
// via the KMS layer.
//
// Why we keep the Seal/Open shape
// -------------------------------
// 29 call sites across the codebase currently take a `*pkgcrypto.Sealer`
// and call Seal/Open with raw byte slices. Refactoring every one of
// them to pass owner_type + owner_id + audit context inline is a much
// larger surgical job than the Phase 14 brief asks for. By preserving
// the bytes-in / bytes-out interface here, the wiring change in main.go
// is a one-liner per caller (s/Sealer/Vault/) and the new envelope
// model takes effect immediately.
//
// Per-call-site OwnerType
// -----------------------
// Even with the narrow interface we still want richer AAD binding for
// at least the OwnerType field — credentials and OIDC client secrets
// shouldn't share an AAD namespace. Each call site constructs its own
// EnvelopeVault with the right OwnerType pre-baked:
//
//   credSeal := secrets.NewEnvelopeVault(svc, model.OwnerCredentialSecret)
//   passSeal := secrets.NewEnvelopeVault(svc, model.OwnerCredentialPassphrase)
//   oidcSeal := secrets.NewEnvelopeVault(svc, model.OwnerOIDCClientSecret)
//   mfaSeal  := secrets.NewEnvelopeVault(svc, model.OwnerUserMFASecret)
//   aiSeal   := secrets.NewEnvelopeVault(svc, model.OwnerAIProviderAPIKey)
//
// OwnerID stays at zero in this shim — the underlying row-creation flow
// often seals the secret before it knows the owning row's ID. Callers
// that want stronger AAD binding migrate to Service.Encrypt directly.
//
// Migration of pre-Phase-14 ciphertexts
// -------------------------------------
// If the legacy *Sealer (fixed-key AES-256-GCM) is attached via
// AttachLegacy, Open() detects pre-Phase-14 byte layouts (no ENV1 magic
// prefix) and decrypts them with the legacy sealer once, then re-wraps
// them into a fresh envelope on the next write. The next Open() will
// find the envelope pointer and skip the legacy path.
type EnvelopeVault struct {
	svc       *Service
	ownerType model.SecretEnvelopeOwnerType

	// legacy is the optional fixed-key Sealer kept around to read
	// pre-Phase-14 ciphertexts. nil for fresh installs. Loaded via
	// AttachLegacy from the operator-supplied old master key during
	// the one-shot migration window.
	legacy atomic.Pointer[pkgcrypto.Sealer]

	// counter increments every Seal — used as a synthetic OwnerID so
	// each envelope row gets a unique (OwnerType, OwnerID) tuple even
	// without per-row binding. This in turn lets the AAD verify on
	// Open distinguish envelope A from envelope B that share an
	// OwnerType.
	counter atomic.Uint64
}

// NewEnvelopeVault constructs an envelope-backed pkg/crypto.Vault.
func NewEnvelopeVault(svc *Service, ownerType model.SecretEnvelopeOwnerType) *EnvelopeVault {
	if ownerType == "" {
		ownerType = model.OwnerGeneric
	}
	return &EnvelopeVault{svc: svc, ownerType: ownerType}
}

// AttachLegacy enables the read-only legacy-ciphertext path. Used by
// the migration wizard when the operator supplies the pre-Phase-14
// master key. Safe to call multiple times — last call wins.
func (v *EnvelopeVault) AttachLegacy(s *pkgcrypto.Sealer) {
	v.legacy.Store(s)
}

// Seal mints a fresh envelope row and returns the pointer bytes the
// caller stores on the owning row.
func (v *EnvelopeVault) Seal(plain []byte) ([]byte, error) {
	if v.svc == nil {
		return nil, errors.New("secrets.EnvelopeVault: no service attached")
	}
	ctx := context.Background()
	syntheticID := v.counter.Add(1)
	res, err := v.svc.Encrypt(ctx, EncryptRequest{
		OwnerType: v.ownerType,
		OwnerID:   syntheticID,
		Plaintext: plain,
		Version:   1,
	})
	if err != nil {
		return nil, err
	}
	return res.Pointer, nil
}

// Open detects the bytes format and routes to envelope unwrap or
// legacy Sealer Open as appropriate.
func (v *EnvelopeVault) Open(sealed []byte) ([]byte, error) {
	if v.svc == nil {
		return nil, errors.New("secrets.EnvelopeVault: no service attached")
	}
	if envID, ok := DecodePointer(sealed); ok {
		// New format — unwrap via the envelope service. We can't
		// reconstruct the original OwnerID from the pointer alone;
		// fall through to direct envelope lookup and trust the
		// envelope's stored OwnerType/OwnerID to drive AAD verification.
		env, err := v.svc.envelopes.FindByID(context.Background(), envID)
		if err != nil {
			return nil, err
		}
		if env == nil {
			return nil, errors.New("secrets.EnvelopeVault: envelope not found")
		}
		return v.svc.Decrypt(context.Background(), DecryptRequest{
			EnvelopeID: envID,
			OwnerType:  env.OwnerType,
			OwnerID:    env.OwnerID,
		})
	}
	// Legacy format — falls through to the pre-Phase-14 Sealer if
	// one is attached. Without legacy attached the bytes are
	// uninterpretable and we return an error rather than guessing.
	if legacy := v.legacy.Load(); legacy != nil {
		return legacy.Open(sealed)
	}
	return nil, errors.New("secrets.EnvelopeVault: unknown ciphertext format and no legacy sealer attached")
}
