package audit

import (
	"testing"
	"time"

	"github.com/michongs/wayfort/internal/model"
)

func ev(kind model.AuditEventKind, user uint64, payload string, at time.Time) model.AuditLog {
	return model.AuditLog{Kind: kind, UserID: user, Payload: payload, CreatedAt: at}
}

func TestHashEntry_Deterministic(t *testing.T) {
	at := time.Unix(1700000000, 0)
	a := ev(model.AuditCommand, 1, "ls -la", at)
	h1 := HashEntry("prev", a)
	h2 := HashEntry("prev", a)
	if h1 != h2 {
		t.Fatal("same entry + prev must hash identically")
	}
	// Changing the link or any content field changes the hash.
	if HashEntry("prev", a) == HashEntry("other", a) {
		t.Fatal("different prev must change the hash")
	}
	b := a
	b.Payload = "rm -rf /"
	if HashEntry("prev", a) == HashEntry("prev", b) {
		t.Fatal("different payload must change the hash")
	}
}

func TestChainer_StampAndVerify(t *testing.T) {
	c := NewChainer("inst-1", "")
	at := time.Unix(1700000000, 0)
	rows := []model.AuditLog{
		ev(model.AuditLogin, 1, "ok", at),
		ev(model.AuditCommand, 1, "whoami", at.Add(time.Second)),
		ev(model.AuditCommand, 1, "sudo reboot", at.Add(2*time.Second)),
	}
	_, commit := c.Stamp(rows)
	commit()

	// Every row got chained to the instance + the previous row.
	for i := range rows {
		if rows[i].ChainID != "inst-1" || rows[i].EntryHash == "" {
			t.Fatalf("row %d not stamped: %+v", i, rows[i])
		}
		if i > 0 && rows[i].PrevHash != rows[i-1].EntryHash {
			t.Fatalf("row %d prev_hash does not link to row %d", i, i-1)
		}
	}
	if ok, at := VerifyChain(rows); !ok {
		t.Fatalf("freshly stamped chain must verify, broke at %d", at)
	}
}

func TestVerifyChain_DetectsTamperedPayload(t *testing.T) {
	c := NewChainer("inst", "")
	now := time.Unix(1700000000, 0)
	rows := []model.AuditLog{
		ev(model.AuditCommand, 1, "a", now),
		ev(model.AuditCommand, 1, "b", now.Add(time.Second)),
		ev(model.AuditCommand, 1, "c", now.Add(2*time.Second)),
	}
	_, commit := c.Stamp(rows)
	commit()

	// An attacker rewrites row 1's payload after the fact, leaving its stored
	// hash intact — verification must catch the mismatch at row 1.
	rows[1].Payload = "rm -rf /"
	ok, brokenAt := VerifyChain(rows)
	if ok || brokenAt != 1 {
		t.Fatalf("tampered payload must break at row 1, got ok=%v at=%d", ok, brokenAt)
	}
}

func TestVerifyChain_DetectsDeletedRow(t *testing.T) {
	c := NewChainer("inst", "")
	now := time.Unix(1700000000, 0)
	rows := []model.AuditLog{
		ev(model.AuditCommand, 1, "a", now),
		ev(model.AuditCommand, 1, "b", now.Add(time.Second)),
		ev(model.AuditCommand, 1, "c", now.Add(2*time.Second)),
	}
	_, commit := c.Stamp(rows)
	commit()

	// Drop the middle row — the third row's prev_hash no longer matches.
	spliced := []model.AuditLog{rows[0], rows[2]}
	ok, brokenAt := VerifyChain(spliced)
	if ok || brokenAt != 1 {
		t.Fatalf("deleted row must break the chain at index 1, got ok=%v at=%d", ok, brokenAt)
	}
}

func TestChainer_DropResiliencePreservesContinuity(t *testing.T) {
	// A batch that fails to insert (commit not called) must NOT advance the tip,
	// so the next batch chains to the last GOOD row — the surviving chain stays
	// verifiable even though the dropped batch's events are lost.
	c := NewChainer("inst", "")
	now := time.Unix(1700000000, 0)

	good := []model.AuditLog{ev(model.AuditCommand, 1, "kept", now)}
	_, commitGood := c.Stamp(good)
	commitGood() // inserted

	dropped := []model.AuditLog{ev(model.AuditCommand, 1, "lost", now.Add(time.Second))}
	_, _ = c.Stamp(dropped) // insert FAILED → commit NOT called

	next := []model.AuditLog{ev(model.AuditCommand, 1, "after", now.Add(2*time.Second))}
	_, commitNext := c.Stamp(next)
	commitNext()

	// The persisted chain is good + next (dropped never landed). It must verify
	// and next must chain to good, not to the lost row.
	if next[0].PrevHash != good[0].EntryHash {
		t.Fatal("after a dropped batch, the next row must chain to the last inserted row")
	}
	if ok, at := VerifyChain([]model.AuditLog{good[0], next[0]}); !ok {
		t.Fatalf("surviving chain must verify after a dropped batch, broke at %d", at)
	}
}
