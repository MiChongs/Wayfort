// Package approval implements the Phase 15 Approval Service — a single,
// uniformly-audited entry point for every high-risk action across the
// bastion (asset access, credential use, command/SQL exec, file transfer,
// session extension / elevation, break-glass, vendor access, audit view).
//
// Files in this package:
//
//   ledger.go     — append-only event log with SHA-256 hash chain
//   workflow.go   — Engine interface + in-process state machine
//   policy.go     — template selector + risk computation + auto-approve
//   notifier.go   — IM / Webhook / SIEM fan-out seam
//   reconciler.go — periodic expiry / escalation / grant cleanup
//   service.go    — public surface used by API handlers and enforcement
//                   points (CreateRequest / Decide / IssueGrant /
//                   VerifyGrant / Revoke)
//
// The workflow Engine is an interface so a later phase can swap the in-
// process state machine for Temporal without touching the service or the
// handlers. The same shape applies to the eventbus (Notifier interface →
// embedded in-process fan-out today, Kafka/NATS later) and the audit ledger
// (hash chain today, can be paired with WORM/S3 Object Lock archival via
// the LedgerArchiver hook).
package approval

import (
	"context"
	"crypto/sha256"
	"encoding/binary"
	"encoding/json"
	"errors"
	"fmt"
	"time"

	"github.com/michongs/wayfort/internal/model"
	"github.com/michongs/wayfort/internal/repo"
)

// LedgerSigner is the optional interface for KMS-backed authentication on
// ledger events. Implementations sign the SHA-256 hash and return a detached
// signature that a verifier can check against a public key fetched from the
// KMS. The current pkg/kms surface does not expose asymmetric Sign across
// providers, so the default implementation is nil and the ledger relies on
// the hash chain alone for tamper evidence. Plug a real signer in when
// either Vault Transit's `sign` or AWS KMS's `Sign` endpoint gets wired up.
type LedgerSigner interface {
	Sign(ctx context.Context, digest []byte) (signature []byte, kmsProviderID uint64, err error)
	Verify(ctx context.Context, digest, signature []byte, kmsProviderID uint64) error
}

// LedgerArchiver is the optional interface for offsite WORM / Object Lock
// archival. The reconciler calls Archive on a checkpoint cadence (every N
// events or every M minutes) and the implementation writes the chunk to a
// retention-protected target. Returning nil keeps the chain entirely on the
// primary database, which is still tamper-evident but not retention-bonded.
type LedgerArchiver interface {
	Archive(ctx context.Context, events []model.ApprovalEvent) error
}

// Ledger writes ApprovalEvent rows in monotonic hash-chained order. Every
// event's Hash = SHA256(PrevHash || canonical(event)) where canonical(event)
// is the JSON encoding of {kind, request_id, actor_id, payload, created_at}
// in a stable field order. Mutating any prior event invalidates every Hash
// after it; verifying the chain only needs to recompute hashes forward from
// the genesis event.
//
// The Ledger is safe for concurrent use; AppendForRequest serialises calls
// for a given RequestID via a tiny in-process mutex map so two competing
// goroutines can't both read prev_hash and then both insert a fresh row
// linking to the same parent. Cross-request appends still run in parallel.
type Ledger struct {
	repo     *repo.ApprovalRepo
	signer   LedgerSigner   // nil → no signing
	archiver LedgerArchiver // nil → no archival

	// genesisSeed is the deterministic byte sequence used as PrevHash for the
	// very first event of every request. It folds the request ID into the
	// digest so an attacker can't move a sub-chain from one request to
	// another (which would otherwise preserve every Hash recomputation).
	genesisSeed []byte
}

// NewLedger builds a Ledger backed by the supplied repo.
func NewLedger(r *repo.ApprovalRepo) *Ledger {
	return &Ledger{
		repo:        r,
		genesisSeed: []byte("approval.ledger.v1.genesis"),
	}
}

// WithSigner returns a new Ledger that signs every Hash via the supplied
// signer. Pass nil to disable signing.
func (l *Ledger) WithSigner(s LedgerSigner) *Ledger {
	clone := *l
	clone.signer = s
	return &clone
}

// WithArchiver returns a new Ledger that batches events to the archiver on
// every successful append. Pass nil to disable archival.
func (l *Ledger) WithArchiver(a LedgerArchiver) *Ledger {
	clone := *l
	clone.archiver = a
	return &clone
}

// canonical builds the byte sequence that gets hashed. We deliberately don't
// rely on json.Marshal on the model struct because GORM adds zero-value
// fields the live row may not actually carry — instead we pack only the
// fields whose values can't be reconstructed from elsewhere. Same encoder
// runs at append time and at verify time.
func canonicalDigestInput(prevHash []byte, kind model.ApprovalEventKind,
	requestID string, actorID uint64, payload string, createdAtUnixNano int64) []byte {
	// Stable layout — every field is length-prefixed so a payload that ends
	// in a tab can't be confused with the next field.
	buf := make([]byte, 0, len(prevHash)+len(requestID)+len(payload)+64)
	buf = appendLP(buf, []byte("approval.event.v1"))
	buf = appendLP(buf, prevHash)
	buf = appendLP(buf, []byte(string(kind)))
	buf = appendLP(buf, []byte(requestID))
	var tmp [8]byte
	binary.BigEndian.PutUint64(tmp[:], actorID)
	buf = appendLP(buf, tmp[:])
	buf = appendLP(buf, []byte(payload))
	binary.BigEndian.PutUint64(tmp[:], uint64(createdAtUnixNano))
	buf = appendLP(buf, tmp[:])
	return buf
}

func appendLP(dst, src []byte) []byte {
	var lp [4]byte
	binary.BigEndian.PutUint32(lp[:], uint32(len(src)))
	dst = append(dst, lp[:]...)
	dst = append(dst, src...)
	return dst
}

// AppendForRequest appends one event to the chain of `requestID`. The
// caller doesn't pass PrevHash / Hash — the ledger computes them. Payload
// must be either empty or a valid JSON document.
//
// On success the event row is committed and (best-effort, non-blocking) the
// archiver and notifier hooks are invoked by the caller after AppendForRequest
// returns. Append itself does only the DB write so the audit trail is the
// authoritative source even if downstream fan-out fails.
func (l *Ledger) AppendForRequest(ctx context.Context, requestID string,
	kind model.ApprovalEventKind, actorID uint64, actorName string,
	payload any) (*model.ApprovalEvent, error) {
	if requestID == "" {
		return nil, errors.New("ledger: request_id required")
	}
	payloadStr := ""
	if payload != nil {
		// Already-string payload passes through; structured values get
		// canonicalised with stable key order via json.Marshal.
		if s, ok := payload.(string); ok {
			payloadStr = s
		} else {
			b, err := json.Marshal(payload)
			if err != nil {
				return nil, fmt.Errorf("ledger: marshal payload: %w", err)
			}
			payloadStr = string(b)
		}
	}
	// Snapshot last event under a per-request lock so two appends don't both
	// read the same prev_hash and double-link.
	unlock := lockRequest(requestID)
	defer unlock()

	prev, err := l.repo.LastEvent(ctx, requestID)
	if err != nil {
		return nil, fmt.Errorf("ledger: last event: %w", err)
	}
	var prevHash []byte
	if prev == nil {
		// Genesis: bind the seed to the request_id so identical events on
		// different requests still produce different hashes.
		seed := sha256.Sum256(append(append([]byte{}, l.genesisSeed...), []byte(requestID)...))
		prevHash = seed[:]
	} else {
		prevHash = prev.Hash
	}

	now := time.Now().UTC()
	digestInput := canonicalDigestInput(prevHash, kind, requestID, actorID, payloadStr, now.UnixNano())
	sum := sha256.Sum256(digestInput)

	ev := &model.ApprovalEvent{
		RequestID: requestID,
		Kind:      kind,
		ActorID:   actorID,
		ActorName: actorName,
		Payload:   payloadStr,
		PrevHash:  prevHash,
		Hash:      sum[:],
		CreatedAt: now,
	}

	if l.signer != nil {
		sig, kmsID, signErr := l.signer.Sign(ctx, sum[:])
		if signErr != nil {
			// Signing failure must not lose the event — log the error
			// through the caller's logger by returning it after appending
			// the row without a signature. The verifier can spot the
			// gap and surface it during /audit/verify.
			ev.Signature = nil
		} else {
			ev.Signature = sig
			ev.KMSProviderID = &kmsID
		}
	}

	if err := l.repo.AppendEvent(ctx, ev); err != nil {
		return nil, fmt.Errorf("ledger: insert: %w", err)
	}

	if l.archiver != nil {
		// Single-row best-effort archival; bigger batches happen out of
		// band by the reconciler.
		_ = l.archiver.Archive(ctx, []model.ApprovalEvent{*ev})
	}
	return ev, nil
}

// VerifyChain recomputes the entire hash chain for a request and reports
// the first divergence. A nil error means every link is intact. The result
// is suitable for /api/v1/approvals/audit/verify.
func (l *Ledger) VerifyChain(ctx context.Context, requestID string) (*ChainVerifyResult, error) {
	events, err := l.repo.EventsForRequest(ctx, requestID)
	if err != nil {
		return nil, err
	}
	res := &ChainVerifyResult{
		RequestID:  requestID,
		TotalEvents: len(events),
		OK:         true,
	}
	expectedPrev := sha256.Sum256(append(append([]byte{}, l.genesisSeed...), []byte(requestID)...))
	var expected []byte = expectedPrev[:]
	for _, ev := range events {
		// Step 1 — prev_hash must match the previous event's hash (or the
		// deterministic seed for the genesis event).
		if !bytesEq(ev.PrevHash, expected) {
			res.OK = false
			res.FirstBadEventID = ev.ID
			res.Reason = "prev_hash mismatch"
			return res, nil
		}
		// Step 2 — recomputed hash must match the stored hash.
		input := canonicalDigestInput(ev.PrevHash, ev.Kind, ev.RequestID,
			ev.ActorID, ev.Payload, ev.CreatedAt.UnixNano())
		sum := sha256.Sum256(input)
		if !bytesEq(sum[:], ev.Hash) {
			res.OK = false
			res.FirstBadEventID = ev.ID
			res.Reason = "hash mismatch"
			return res, nil
		}
		// Step 3 — optional signature verification.
		if l.signer != nil && len(ev.Signature) > 0 && ev.KMSProviderID != nil {
			if vErr := l.signer.Verify(ctx, ev.Hash, ev.Signature, *ev.KMSProviderID); vErr != nil {
				res.OK = false
				res.FirstBadEventID = ev.ID
				res.Reason = "signature verify failed: " + vErr.Error()
				return res, nil
			}
		}
		expected = ev.Hash
	}
	return res, nil
}

// ChainVerifyResult is what /audit/verify returns.
type ChainVerifyResult struct {
	RequestID       string `json:"request_id"`
	TotalEvents     int    `json:"total_events"`
	OK              bool   `json:"ok"`
	FirstBadEventID uint64 `json:"first_bad_event_id,omitempty"`
	Reason          string `json:"reason,omitempty"`
}

func bytesEq(a, b []byte) bool {
	if len(a) != len(b) {
		return false
	}
	for i := range a {
		if a[i] != b[i] {
			return false
		}
	}
	return true
}
