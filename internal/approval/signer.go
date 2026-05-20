package approval

import (
	"context"
	"errors"

	"github.com/michongs/jumpserver-anonymous/pkg/kms"
)

// KMSSignerLookup is the closure the bootstrap hands the ledger so each
// signing attempt resolves the *currently primary* KMS provider. Doing
// the lookup per call (instead of capturing a provider at construction)
// is what lets `POST /api/v1/setup/kms/:id/promote` swap the primary KMS
// without restarting the gateway — ledger writes that arrive after the
// swap automatically pick up the new key.
type KMSSignerLookup func(ctx context.Context) (kms.Signer, uint64, error)

// kmsLedgerSigner is the LedgerSigner implementation that delegates to a
// KMS provider's Signer capability (Ed25519 for Local; Vault Transit /
// AWS / Azure / GCP filled in subsequent PRs). When the active KMS
// doesn't expose Sign — every provider except Local in this phase — the
// lookup returns kms.ErrSignNotSupported and the ledger continues with
// chain-only tamper evidence.
type kmsLedgerSigner struct {
	lookup KMSSignerLookup
}

// NewKMSLedgerSigner constructs a LedgerSigner that signs via the
// caller-supplied lookup. Returns nil when lookup is nil so the caller
// can pass `NewKMSLedgerSigner(nil)` to express "no signing".
func NewKMSLedgerSigner(lookup KMSSignerLookup) LedgerSigner {
	if lookup == nil {
		return nil
	}
	return &kmsLedgerSigner{lookup: lookup}
}

// Sign asks the current primary KMS to produce a detached signature over
// the supplied digest. ErrSignNotSupported is bubbled up to the ledger so
// it falls through to chain-only mode for this event rather than blocking
// the write — losing tamper-evidence on a single event is preferable to
// losing the event itself.
func (s *kmsLedgerSigner) Sign(ctx context.Context, digest []byte) ([]byte, uint64, error) {
	signer, providerID, err := s.lookup(ctx)
	if err != nil {
		return nil, 0, err
	}
	if signer == nil {
		return nil, 0, kms.ErrSignNotSupported
	}
	sig, err := signer.Sign(ctx, digest)
	if err != nil {
		return nil, 0, err
	}
	return sig, providerID, nil
}

// Verify looks up the recorded provider (currently the primary; if a
// provider was rotated AFTER an event was signed the verifier needs to
// route to the OLD provider — that requires a provider-id-keyed map,
// shipped in the next PR alongside Vault/AWS sign).
func (s *kmsLedgerSigner) Verify(ctx context.Context, digest, signature []byte, _ uint64) error {
	signer, _, err := s.lookup(ctx)
	if err != nil {
		return err
	}
	if signer == nil {
		return errors.New("ledger verify: signer unavailable")
	}
	return signer.Verify(ctx, digest, signature)
}
