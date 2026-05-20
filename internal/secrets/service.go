// Package secrets is the envelope-encryption service layer for the
// Phase 14 credential pool. It sits between the rest of the codebase
// (which still talks `pkg/crypto.Vault`'s Seal/Open) and the per-row
// envelope storage + KMS-managed KEK custody.
//
// Flow at encrypt
// ---------------
//
//   1. Caller hands plaintext + AAD inputs.
//   2. Service mints a fresh 32-byte DEK.
//   3. Service AEAD-encrypts plaintext under DEK with the canonical
//      AAD (sha256 of the canonical AAD goes on the envelope row).
//   4. Service hands DEK to the primary KMS to be wrapped under the
//      configured KEK.
//   5. Service writes a SecretEnvelope row and a SecretAudit row.
//   6. Service zeroes the DEK and the plaintext slice in memory.
//
// Flow at decrypt
// ---------------
//
//   1. Caller hands the envelope ID + AAD inputs + audit context.
//   2. Service loads the SecretEnvelope row, verifies status==active.
//   3. Service verifies AAD hash against the supplied AAD inputs.
//   4. Service asks the wrapping KMS to unwrap EncryptedDEK.
//   5. Service AEAD-decrypts Ciphertext under the unwrapped DEK with
//      the canonical AAD.
//   6. Service writes a SecretAudit row (success or failure).
//   7. Service zeroes the DEK and returns plaintext.
//
// The plaintext lifetime is the caller's responsibility — Service
// passes it back as a `[]byte` and the credential dispatcher /
// session-builder code wipes it once it's been forwarded to the SSH
// / RDP / DB worker.
package secrets

import (
	"context"
	"errors"
	"fmt"
	"sync"
	"time"

	"github.com/michongs/jumpserver-anonymous/internal/model"
	"github.com/michongs/jumpserver-anonymous/internal/repo"
	pkgcrypto "github.com/michongs/jumpserver-anonymous/pkg/crypto"
	"github.com/michongs/jumpserver-anonymous/pkg/kms"
)

// Service is the envelope encryption gateway. There is exactly one of
// these in a running process; construction is via NewService in
// bootstrap.go.
//
// Concurrency: methods are safe for parallel use. The primary KMS
// reference is read under a RWMutex so the live primary can be swapped
// atomically by /setup/kms without restarting the gateway.
type Service struct {
	envelopes *repo.SecretEnvelopeRepo
	providers *repo.KMSProviderRepo
	audits    *repo.SecretAuditRepo

	mu      sync.RWMutex
	primary kms.KMS         // wrapper used to wrap fresh envelopes
	cache   map[uint64]kms.KMS // resolved providers, keyed by KMSProvider.ID
	// decryptGate is the Phase 16 approval enforcement hook. Invoked
	// inside Decrypt BEFORE any KMS call so a denied decrypt skips
	// network round-trips. nil disables the gate (default).
	decryptGate DecryptGate

	unsealer *kms.Unsealer
}

// DecryptGate is the approval-enforcement contract Decrypt invokes once it
// has loaded the envelope row but before it asks the KMS to unwrap. The
// implementation is wired by cmd/jumpserver during bootstrap; secrets
// itself remains free of any approval-package import.
type DecryptGate func(ctx context.Context, ownerType model.SecretEnvelopeOwnerType, ownerID uint64, audit AuditContext) error

// Deps groups the constructor inputs.
type Deps struct {
	Envelopes *repo.SecretEnvelopeRepo
	Providers *repo.KMSProviderRepo
	Audits    *repo.SecretAuditRepo
	// Unsealer was derived from the operator's bootstrap passphrase
	// during boot. The Service holds it so it can resolve secondary
	// providers (other rows in kms_providers) on demand.
	Unsealer *kms.Unsealer
	// Primary is the resolved KMS instance for the primary row. The
	// bootstrap code does the resolution because it has the full
	// context (row + unsealer); we just take ownership here.
	Primary    kms.KMS
	PrimaryRow *model.KMSProvider
}

// NewService constructs a Service. The cache is pre-populated with the
// primary; secondary providers are resolved lazily on first decrypt
// of an envelope that points at them.
func NewService(deps Deps) *Service {
	s := &Service{
		envelopes: deps.Envelopes,
		providers: deps.Providers,
		audits:    deps.Audits,
		primary:   deps.Primary,
		unsealer:  deps.Unsealer,
		cache:     map[uint64]kms.KMS{},
	}
	if deps.PrimaryRow != nil {
		s.cache[deps.PrimaryRow.ID] = deps.Primary
	}
	return s
}

// SetPrimary atomically replaces the live primary. Used by the
// `/api/v1/setup/kms/promote` path; existing envelopes wrapped by
// the previous primary remain decryptable (their ProviderID still
// resolves), and new envelopes are wrapped by the new primary.
func (s *Service) SetPrimary(provider kms.KMS, row *model.KMSProvider) {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.primary = provider
	if row != nil {
		s.cache[row.ID] = provider
	}
}

// SetDecryptGate wires the Phase 16 approval gate. Pass nil to clear it.
// Safe to call after construction; takes effect on the next Decrypt.
func (s *Service) SetDecryptGate(g DecryptGate) {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.decryptGate = g
}

// decryptGateOf returns the current gate under the read lock so callers
// can invoke it without holding the lock through the gate execution.
func (s *Service) decryptGateOf() DecryptGate {
	s.mu.RLock()
	defer s.mu.RUnlock()
	return s.decryptGate
}

// PrimaryProvider exposes the active primary for code that needs to
// surface it in /setup/status or run a Healthcheck. Returns nil if
// the gateway is sealed (Service constructed in sealed mode).
func (s *Service) PrimaryProvider() kms.KMS {
	s.mu.RLock()
	defer s.mu.RUnlock()
	return s.primary
}

// EncryptRequest groups the inputs to Encrypt.
type EncryptRequest struct {
	OwnerType model.SecretEnvelopeOwnerType
	OwnerID   uint64
	// Plaintext is the raw secret bytes the caller wants sealed. The
	// service does NOT take a copy; the caller wipes after return.
	Plaintext []byte
	// Version is the per-owner credential version. New credentials
	// start at 1; rotations bump it.
	Version int
	// Extra is the optional context (tenant, session id, etc.)
	// folded into the AAD.
	Extra map[string]string
	// Audit is the caller-supplied per-decrypt context — user, IP,
	// reason. Optional but recommended.
	Audit AuditContext
}

// EncryptResult is what Encrypt hands back.
type EncryptResult struct {
	Envelope *model.SecretEnvelope
	// Pointer is the bytes the caller stores in the owning row's
	// `Secret []byte` column. Format defined by EncodePointer.
	Pointer []byte
}

// AuditContext is the per-call audit material — user ID, source IP,
// human-supplied reason. None of it is mandatory, but every
// production credential decrypt is expected to fill at least UserID
// + Reason.
type AuditContext struct {
	UserID   *uint64
	Username string
	SourceIP string
	Reason   string
	TicketID string
}

// Encrypt seals plaintext into a fresh envelope row.
func (s *Service) Encrypt(ctx context.Context, req EncryptRequest) (*EncryptResult, error) {
	if req.OwnerType == "" {
		return nil, errors.New("secrets.Encrypt: OwnerType required")
	}
	if req.Version <= 0 {
		req.Version = 1
	}
	primary := s.PrimaryProvider()
	if primary == nil {
		return nil, kms.ErrUnsealRequired
	}
	primaryRow, err := s.providers.Primary(ctx)
	if err != nil {
		return nil, fmt.Errorf("secrets.Encrypt: load primary: %w", err)
	}
	if primaryRow == nil {
		return nil, errors.New("secrets.Encrypt: no primary KMS provider configured")
	}

	// Mint a DEK + seal plaintext under it with the canonical AAD.
	dek, err := pkgcrypto.GenerateDEK()
	if err != nil {
		return nil, fmt.Errorf("secrets.Encrypt: generate DEK: %w", err)
	}
	defer wipe(dek)

	gcm, err := pkgcrypto.NewAESGCM(dek)
	if err != nil {
		return nil, fmt.Errorf("secrets.Encrypt: new AES-GCM: %w", err)
	}
	nonce, err := pkgcrypto.RandomBytes(gcm.NonceSize())
	if err != nil {
		return nil, fmt.Errorf("secrets.Encrypt: nonce: %w", err)
	}
	aadInput := AADInput{
		OwnerType: req.OwnerType,
		OwnerID:   req.OwnerID,
		Version:   req.Version,
		Extra:     req.Extra,
	}
	aadBytes := aadInput.Build()
	ciphertext := gcm.Seal(nil, nonce, req.Plaintext, aadBytes)

	// Wrap the DEK under the primary KEK.
	wrapped, err := primary.EncryptDEK(ctx, dek, EncryptionContextFor(aadInput))
	if err != nil {
		s.auditFailure(ctx, model.AuditOpEncrypt, 0, req.OwnerType, req.OwnerID, primaryRow, req.Audit, err)
		return nil, fmt.Errorf("secrets.Encrypt: wrap DEK: %w", err)
	}

	env := &model.SecretEnvelope{
		OwnerType:    req.OwnerType,
		OwnerID:      req.OwnerID,
		Ciphertext:   ciphertext,
		Nonce:        nonce,
		EncryptedDEK: wrapped.Ciphertext,
		ProviderID:   primaryRow.ID,
		KeyID:        wrapped.KeyID,
		KeyVersion:   wrapped.KeyVersion,
		Algorithm:    "aes-256-gcm",
		AADHash:      aadInput.Hash(),
		Version:      req.Version,
		Status:       model.EnvelopeActive,
	}
	if err := s.envelopes.Create(ctx, env); err != nil {
		return nil, fmt.Errorf("secrets.Encrypt: persist envelope: %w", err)
	}

	s.auditSuccess(ctx, model.AuditOpEncrypt, env.ID, req.OwnerType, req.OwnerID, primaryRow, req.Audit)
	return &EncryptResult{Envelope: env, Pointer: EncodePointer(env.ID)}, nil
}

// DecryptRequest groups the inputs to Decrypt.
type DecryptRequest struct {
	// One of EnvelopeID or Pointer must be set. Pointer is the
	// bytes-on-the-row representation; the service decodes it to
	// recover the envelope ID.
	EnvelopeID uint64
	Pointer    []byte
	// OwnerType/OwnerID must match the row — the AAD binding will
	// reject the decrypt otherwise.
	OwnerType model.SecretEnvelopeOwnerType
	OwnerID   uint64
	Extra     map[string]string
	Audit     AuditContext
}

// Decrypt unwraps + verifies + decrypts the envelope, returning
// plaintext bytes the caller is responsible for wiping.
func (s *Service) Decrypt(ctx context.Context, req DecryptRequest) ([]byte, error) {
	envID := req.EnvelopeID
	if envID == 0 && len(req.Pointer) > 0 {
		id, ok := DecodePointer(req.Pointer)
		if !ok {
			return nil, fmt.Errorf("secrets.Decrypt: invalid pointer")
		}
		envID = id
	}
	if envID == 0 {
		return nil, errors.New("secrets.Decrypt: envelope id required")
	}

	env, err := s.envelopes.FindByID(ctx, envID)
	if err != nil {
		return nil, fmt.Errorf("secrets.Decrypt: load envelope: %w", err)
	}
	if env == nil {
		return nil, fmt.Errorf("secrets.Decrypt: envelope %d not found", envID)
	}
	if env.Status == model.EnvelopeRevoked {
		s.auditFailure(ctx, model.AuditOpDecrypt, env.ID, env.OwnerType, env.OwnerID, nil, req.Audit, errors.New("envelope revoked"))
		return nil, errors.New("secrets.Decrypt: envelope revoked")
	}
	if env.OwnerType != req.OwnerType || env.OwnerID != req.OwnerID {
		err := fmt.Errorf("secrets.Decrypt: owner mismatch — envelope %d is (%s,%d), request was (%s,%d)",
			env.ID, env.OwnerType, env.OwnerID, req.OwnerType, req.OwnerID)
		s.auditFailure(ctx, model.AuditOpDecrypt, env.ID, env.OwnerType, env.OwnerID, nil, req.Audit, err)
		return nil, err
	}

	// Phase 16 — invoke the approval gate before we ask the KMS to
	// unwrap. A denied decrypt audits as a failure and bubbles back to
	// the caller; the caller is expected to be a handler that converts
	// the error into a 403 with an "approval_required" hint.
	if gate := s.decryptGateOf(); gate != nil {
		if err := gate(ctx, env.OwnerType, env.OwnerID, req.Audit); err != nil {
			s.auditFailure(ctx, model.AuditOpDecrypt, env.ID, env.OwnerType, env.OwnerID, nil, req.Audit, err)
			return nil, err
		}
	}

	// Verify AAD binding before we hit the KMS.
	aadInput := AADInput{
		OwnerType: env.OwnerType,
		OwnerID:   env.OwnerID,
		Version:   env.Version,
		Extra:     req.Extra,
	}
	if err := Verify(aadInput, env.AADHash); err != nil {
		s.auditFailure(ctx, model.AuditOpDecrypt, env.ID, env.OwnerType, env.OwnerID, nil, req.Audit, err)
		return nil, err
	}

	provider, providerRow, err := s.providerFor(ctx, env.ProviderID)
	if err != nil {
		s.auditFailure(ctx, model.AuditOpDecrypt, env.ID, env.OwnerType, env.OwnerID, nil, req.Audit, err)
		return nil, err
	}

	dek, err := provider.DecryptDEK(ctx, env.EncryptedDEK, env.KeyID, env.KeyVersion, EncryptionContextFor(aadInput))
	if err != nil {
		s.auditFailure(ctx, model.AuditOpDecrypt, env.ID, env.OwnerType, env.OwnerID, providerRow, req.Audit, err)
		return nil, fmt.Errorf("secrets.Decrypt: unwrap DEK: %w", err)
	}
	defer wipe(dek)

	gcm, err := pkgcrypto.NewAESGCM(dek)
	if err != nil {
		s.auditFailure(ctx, model.AuditOpDecrypt, env.ID, env.OwnerType, env.OwnerID, providerRow, req.Audit, err)
		return nil, err
	}
	aadBytes := aadInput.Build()
	plaintext, err := gcm.Open(nil, env.Nonce, env.Ciphertext, aadBytes)
	if err != nil {
		s.auditFailure(ctx, model.AuditOpDecrypt, env.ID, env.OwnerType, env.OwnerID, providerRow, req.Audit, err)
		return nil, fmt.Errorf("secrets.Decrypt: AEAD open: %w", err)
	}

	s.auditSuccess(ctx, model.AuditOpDecrypt, env.ID, env.OwnerType, env.OwnerID, providerRow, req.Audit)
	return plaintext, nil
}

// Rewrap re-wraps the envelope's DEK under the current primary KEK.
// The plaintext payload doesn't change; only EncryptedDEK + ProviderID
// + KeyID + KeyVersion move. Used by the rotation job.
func (s *Service) Rewrap(ctx context.Context, envelopeID uint64, audit AuditContext) error {
	env, err := s.envelopes.FindByID(ctx, envelopeID)
	if err != nil {
		return err
	}
	if env == nil {
		return fmt.Errorf("secrets.Rewrap: envelope %d not found", envelopeID)
	}
	if env.Status == model.EnvelopeRevoked {
		return errors.New("secrets.Rewrap: envelope revoked")
	}

	src, _, err := s.providerFor(ctx, env.ProviderID)
	if err != nil {
		return err
	}
	dst := s.PrimaryProvider()
	if dst == nil {
		return kms.ErrUnsealRequired
	}
	dstRow, err := s.providers.Primary(ctx)
	if err != nil {
		return err
	}
	if dstRow == nil {
		return errors.New("secrets.Rewrap: no primary KMS configured")
	}

	aadInput := AADInput{
		OwnerType: env.OwnerType,
		OwnerID:   env.OwnerID,
		Version:   env.Version,
	}
	ec := EncryptionContextFor(aadInput)

	// If source and destination are the same provider, ask it for a
	// native rewrap. Otherwise fall back to unwrap-and-rewrap.
	var newWrapped *kms.WrappedDEK
	if env.ProviderID == dstRow.ID {
		newWrapped, err = src.Rewrap(ctx, env.EncryptedDEK, env.KeyID, env.KeyVersion, ec)
		if err != nil {
			s.auditFailure(ctx, model.AuditOpRewrap, env.ID, env.OwnerType, env.OwnerID, dstRow, audit, err)
			return err
		}
	} else {
		dek, err := src.DecryptDEK(ctx, env.EncryptedDEK, env.KeyID, env.KeyVersion, ec)
		if err != nil {
			s.auditFailure(ctx, model.AuditOpRewrap, env.ID, env.OwnerType, env.OwnerID, dstRow, audit, err)
			return err
		}
		newWrapped, err = dst.EncryptDEK(ctx, dek, ec)
		wipe(dek)
		if err != nil {
			s.auditFailure(ctx, model.AuditOpRewrap, env.ID, env.OwnerType, env.OwnerID, dstRow, audit, err)
			return err
		}
	}

	if err := s.envelopes.UpdateRewrap(ctx, env.ID, newWrapped.Ciphertext, dstRow.ID, newWrapped.KeyID, newWrapped.KeyVersion); err != nil {
		s.auditFailure(ctx, model.AuditOpRewrap, env.ID, env.OwnerType, env.OwnerID, dstRow, audit, err)
		return err
	}
	s.auditSuccess(ctx, model.AuditOpRewrap, env.ID, env.OwnerType, env.OwnerID, dstRow, audit)
	return nil
}

// providerFor resolves a KMS instance for the given provider ID,
// caching the resolution for the lifetime of the process.
func (s *Service) providerFor(ctx context.Context, id uint64) (kms.KMS, *model.KMSProvider, error) {
	s.mu.RLock()
	if cached, ok := s.cache[id]; ok {
		s.mu.RUnlock()
		row, _ := s.providers.FindByID(ctx, id)
		return cached, row, nil
	}
	s.mu.RUnlock()

	row, err := s.providers.FindByID(ctx, id)
	if err != nil {
		return nil, nil, err
	}
	if row == nil {
		return nil, nil, fmt.Errorf("secrets: provider %d not found", id)
	}
	if !row.Enabled {
		return nil, row, kms.ErrProviderDisabled
	}

	authPlain, err := s.unsealAuth(row)
	if err != nil {
		return nil, row, fmt.Errorf("secrets: unseal provider %d: %w", id, err)
	}
	pr, err := kms.New(ctx, kms.ProviderRow{
		ID:            row.ID,
		Name:          row.Name,
		Kind:          kms.Kind(row.Kind),
		Endpoint:      row.Endpoint,
		KeyID:         row.KeyID,
		Namespace:     row.Namespace,
		AuthMethod:    row.AuthMethod,
		AuthRoleID:    row.AuthRoleID,
		AuthPlaintext: authPlain,
		ExtraJSON:     row.ExtraJSON,
	})
	if err != nil {
		return nil, row, err
	}

	s.mu.Lock()
	s.cache[id] = pr
	s.mu.Unlock()
	return pr, row, nil
}

// unsealAuth pulls AuthCiphertext through the Unsealer to recover the
// plaintext auth credential (Vault SecretID / AWS static key JSON /
// Azure client secret / GCP service account JSON / Local KEK).
//
// Returns an empty slice for rows that don't carry sealed auth (e.g.
// AWS / Azure / GCP with auth_method=default rely on the SDK's own
// credential chain).
func (s *Service) unsealAuth(row *model.KMSProvider) ([]byte, error) {
	if len(row.AuthCiphertext) == 0 {
		return nil, nil
	}
	if s.unsealer == nil {
		return nil, kms.ErrUnsealRequired
	}
	return s.unsealer.Open(row.AuthCiphertext)
}

// auditSuccess + auditFailure are convenience wrappers — auditing is
// best-effort, never blocks the calling operation.
func (s *Service) auditSuccess(ctx context.Context, op model.SecretAuditOperation, envelopeID uint64, ownerType model.SecretEnvelopeOwnerType, ownerID uint64, providerRow *model.KMSProvider, audit AuditContext) {
	row := &model.SecretAudit{
		OwnerType:  ownerType,
		OwnerID:    ownerID,
		EnvelopeID: envelopeID,
		Operation:  op,
		Success:    true,
		UserID:     audit.UserID,
		Username:   audit.Username,
		SourceIP:   audit.SourceIP,
		Reason:     audit.Reason,
		TicketID:   audit.TicketID,
		CreatedAt:  time.Now().UTC(),
	}
	if providerRow != nil {
		row.ProviderID = providerRow.ID
		row.KeyID = providerRow.KeyID
	}
	_ = s.audits.Insert(ctx, row)
}

func (s *Service) auditFailure(ctx context.Context, op model.SecretAuditOperation, envelopeID uint64, ownerType model.SecretEnvelopeOwnerType, ownerID uint64, providerRow *model.KMSProvider, audit AuditContext, cause error) {
	msg := ""
	if cause != nil {
		msg = cause.Error()
		if len(msg) > 1024 {
			msg = msg[:1024]
		}
	}
	row := &model.SecretAudit{
		OwnerType:  ownerType,
		OwnerID:    ownerID,
		EnvelopeID: envelopeID,
		Operation:  op,
		Success:    false,
		ErrorMsg:   msg,
		UserID:     audit.UserID,
		Username:   audit.Username,
		SourceIP:   audit.SourceIP,
		Reason:     audit.Reason,
		TicketID:   audit.TicketID,
		CreatedAt:  time.Now().UTC(),
	}
	if providerRow != nil {
		row.ProviderID = providerRow.ID
		row.KeyID = providerRow.KeyID
	}
	_ = s.audits.Insert(ctx, row)
}

// wipe zeroes a byte slice. Best-effort; the GC can copy slices
// before this runs, but it shortens the window plaintext sits in
// freeable memory.
func wipe(b []byte) {
	for i := range b {
		b[i] = 0
	}
}
