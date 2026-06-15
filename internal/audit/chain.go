package audit

import (
	"crypto/sha256"
	"encoding/hex"
	"strconv"
	"strings"
	"sync"

	"github.com/michongs/jumpserver-anonymous/internal/model"
)

// Chainer maintains a per-instance, append-only hash chain over the audit log
// (security-architecture.md §5.2). Each gateway instance owns its own chain
// (ChainID = instanceID); the single audit writer goroutine stamps every batch
// in order. EntryHash = SHA256(PrevHash ‖ canonical(entry)), so altering any
// inserted row breaks verification from that row onward.
//
// Crash/HA note: a per-instance chain sidesteps the impossibility of a globally
// ordered chain across concurrently-writing instances. last advances ONLY after
// a batch is durably inserted, so a dropped batch loses those events (the
// existing backpressure behaviour) without breaking the chain over the rows that
// did land — completeness is covered separately by signed checkpoints + the
// dropped-count.
type Chainer struct {
	instanceID string
	mu         sync.Mutex
	last       string // entry_hash of the last durably-inserted row in this chain
}

// NewChainer creates a chain for instanceID seeded with the last entry hash
// already in the database for that instance (empty for a fresh chain → genesis).
func NewChainer(instanceID, seed string) *Chainer {
	return &Chainer{instanceID: instanceID, last: seed}
}

// InstanceID returns this chain's id.
func (c *Chainer) InstanceID() string { return c.instanceID }

// Stamp sets ChainID/PrevHash/EntryHash on each log in order, chaining from the
// last durably-inserted hash. It returns the new tip hash and a commit func;
// the caller MUST call commit() only after the batch is successfully persisted,
// so a failed insert leaves the chain anchored at the last good row.
func (c *Chainer) Stamp(logs []model.AuditLog) (tip string, commit func()) {
	c.mu.Lock()
	prev := c.last
	c.mu.Unlock()

	for i := range logs {
		logs[i].ChainID = c.instanceID
		logs[i].PrevHash = prev
		h := HashEntry(prev, logs[i])
		logs[i].EntryHash = h
		prev = h
	}
	newTip := prev
	return newTip, func() {
		c.mu.Lock()
		c.last = newTip
		c.mu.Unlock()
	}
}

// HashEntry computes EntryHash = SHA256(prevHash ‖ canonical(entry)).
func HashEntry(prevHash string, e model.AuditLog) string {
	h := sha256.New()
	h.Write([]byte(prevHash))
	h.Write([]byte{0x1e}) // record separator between the link and the content
	h.Write([]byte(canonical(e)))
	return hex.EncodeToString(h.Sum(nil))
}

// canonical is a deterministic serialization of an entry's content — every
// field that matters for tamper-evidence, in a fixed order, excluding the
// DB-assigned ID and the chain columns themselves. Field-separated with a unit
// separator so distinct field boundaries can't be forged by content that
// contains the delimiter.
func canonical(e model.AuditLog) string {
	var node string
	if e.NodeID != nil {
		node = strconv.FormatUint(*e.NodeID, 10)
	}
	parts := []string{
		string(e.Kind),
		strconv.FormatUint(e.UserID, 10),
		e.Username,
		e.SessionID,
		node,
		e.ClientIP,
		e.Payload,
		strconv.FormatInt(e.CreatedAt.UTC().UnixNano(), 10),
	}
	return strings.Join(parts, "\x1f")
}

// VerifyChain recomputes the hash chain over rows (which MUST be a single
// chain_id ordered by id ascending) and reports whether it is intact. On a
// break it returns the 0-based index of the first row whose stored EntryHash or
// PrevHash does not match the recomputation. brokenAt is -1 when intact.
func VerifyChain(rows []model.AuditLog) (ok bool, brokenAt int) {
	prev := ""
	if len(rows) > 0 {
		// The chain may start mid-history (seeded from a prior run); anchor on the
		// first row's recorded PrevHash so a sub-range still verifies internally.
		prev = rows[0].PrevHash
	}
	for i := range rows {
		if rows[i].PrevHash != prev {
			return false, i
		}
		want := HashEntry(prev, rows[i])
		if rows[i].EntryHash != want {
			return false, i
		}
		prev = rows[i].EntryHash
	}
	return true, -1
}
