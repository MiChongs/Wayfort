package audit

import (
	"context"
	"crypto/sha256"
	"strconv"
	"strings"
	"time"

	"github.com/michongs/wayfort/internal/model"
)

// GenesisDay is the sentinel "day" of the anchor checkpoint written when an
// instance first chains. It declares that any rows preceding the chain (the
// pre-M4 NULL-hash history) are outside the protected range.
const GenesisDay = "genesis"

// CheckpointSigner signs a digest, returning the signature and the KMS provider
// id that produced it. It may return kms.ErrSignNotSupported (wrapped) when no
// provider can sign — the checkpoint is then stored unsigned (hash-chain + WORM
// remain the tamper evidence). Shape matches the approval ledger signer.
type CheckpointSigner func(ctx context.Context, digest []byte) (sig []byte, providerID uint64, err error)

// CheckpointStore is the persistence the checkpointer needs (satisfied by
// *repo.AuditRepo).
type CheckpointStore interface {
	ChainTailAndCount(ctx context.Context, chainID string) (tail string, count int64, err error)
	UpsertCheckpoint(ctx context.Context, cp *model.AuditCheckpoint) error
}

// Checkpointer seals a chain's state into signed checkpoints.
type Checkpointer struct {
	chainID string
	store   CheckpointStore
	sign    CheckpointSigner
	dropped func() uint64 // cumulative dropped-event count (from the writer)
}

func NewCheckpointer(chainID string, store CheckpointStore, sign CheckpointSigner, dropped func() uint64) *Checkpointer {
	if dropped == nil {
		dropped = func() uint64 { return 0 }
	}
	return &Checkpointer{chainID: chainID, store: store, sign: sign, dropped: dropped}
}

// WriteGenesis writes the anchor checkpoint for this chain (idempotent).
func (c *Checkpointer) WriteGenesis(ctx context.Context) error {
	return c.write(ctx, GenesisDay, true)
}

// WriteDaily seals the chain's state for the current UTC day (idempotent —
// re-running refreshes the seal with the latest tail/count).
func (c *Checkpointer) WriteDaily(ctx context.Context) error {
	day := time.Now().UTC().Format("2006-01-02")
	return c.write(ctx, day, false)
}

func (c *Checkpointer) write(ctx context.Context, day string, genesis bool) error {
	tail, count, err := c.store.ChainTailAndCount(ctx, c.chainID)
	if err != nil {
		return err
	}
	dropped := int64(c.dropped())
	cp := &model.AuditCheckpoint{
		ChainID:      c.chainID,
		Day:          day,
		TailHash:     tail,
		EntryCount:   count,
		DroppedCount: dropped,
		IsGenesis:    genesis,
	}
	// Sign the canonical tuple. A signer that can't sign (every cloud KMS in this
	// phase) leaves the checkpoint unsigned rather than blocking — explicitly
	// preferred (the hash chain + WORM still bind tamper-evidence).
	if c.sign != nil {
		digest := CheckpointDigest(cp)
		sig, providerID, serr := c.sign(ctx, digest)
		if serr == nil && len(sig) > 0 {
			cp.Signature = sig
			cp.SignerProviderID = providerID
		}
	}
	return c.store.UpsertCheckpoint(ctx, cp)
}

// CheckpointDigest is the SHA-256 over a checkpoint's canonical tuple — what the
// signature covers and what a verifier recomputes.
func CheckpointDigest(cp *model.AuditCheckpoint) []byte {
	parts := []string{
		cp.ChainID,
		cp.Day,
		cp.TailHash,
		strconv.FormatInt(cp.EntryCount, 10),
		strconv.FormatInt(cp.DroppedCount, 10),
	}
	sum := sha256.Sum256([]byte(strings.Join(parts, "\x1f")))
	return sum[:]
}
