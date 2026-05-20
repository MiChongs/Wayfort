package approval

import (
	"bytes"
	"crypto/sha256"
	"testing"

	"github.com/michongs/jumpserver-anonymous/internal/model"
)

// TestCanonicalDigestInput_Deterministic — same inputs produce identical
// bytes. The ledger's tamper-evidence depends on this; if the canonical
// encoder isn't stable, hashes drift between writers and verifiers and the
// chain ceases to be useful.
func TestCanonicalDigestInput_Deterministic(t *testing.T) {
	prev := bytes.Repeat([]byte{0xab}, 32)
	a := canonicalDigestInput(prev, model.ApprovalEvRequestCreated, "req-1", 42, `{"foo":1}`, 1700000000000000000)
	b := canonicalDigestInput(prev, model.ApprovalEvRequestCreated, "req-1", 42, `{"foo":1}`, 1700000000000000000)
	if !bytes.Equal(a, b) {
		t.Fatal("canonicalDigestInput is non-deterministic")
	}
}

// TestCanonicalDigestInput_Sensitive — any single field change shifts the
// digest. Length-prefix layout means even adjacent fields can't be
// reordered into the same hash.
func TestCanonicalDigestInput_Sensitive(t *testing.T) {
	prev := bytes.Repeat([]byte{0xab}, 32)
	a := canonicalDigestInput(prev, model.ApprovalEvRequestCreated, "req-1", 42, `{"foo":1}`, 1700000000000000000)
	b := canonicalDigestInput(prev, model.ApprovalEvRequestRejected, "req-1", 42, `{"foo":1}`, 1700000000000000000)
	c := canonicalDigestInput(prev, model.ApprovalEvRequestCreated, "req-2", 42, `{"foo":1}`, 1700000000000000000)
	d := canonicalDigestInput(prev, model.ApprovalEvRequestCreated, "req-1", 43, `{"foo":1}`, 1700000000000000000)
	e := canonicalDigestInput(prev, model.ApprovalEvRequestCreated, "req-1", 42, `{"foo":2}`, 1700000000000000000)
	f := canonicalDigestInput(prev, model.ApprovalEvRequestCreated, "req-1", 42, `{"foo":1}`, 1700000000000000001)

	hashA := sha256.Sum256(a)
	for _, other := range [][]byte{b, c, d, e, f} {
		h := sha256.Sum256(other)
		if hashA == h {
			t.Fatal("digest input did not change when an input field changed")
		}
	}
}

// TestAppendLP_LengthPrefix — verify a payload that ends in 4 zero bytes
// can't be confused with the next field's length prefix. This is the
// canonicalisation invariant that protects against forgery via tail
// trimming.
func TestAppendLP_LengthPrefix(t *testing.T) {
	a := appendLP(nil, []byte{0, 0, 0, 4}) // body == "\x00\x00\x00\x04" (4 bytes)
	a = appendLP(a, []byte("xxxx"))         // body == "xxxx"

	b := appendLP(nil, []byte{0, 0, 0, 0, 0, 0, 0, 4}) // single body of 8 bytes
	b = appendLP(b, []byte("xxxx"))

	if bytes.Equal(a, b) {
		t.Fatal("appendLP encoding is ambiguous")
	}
}

func TestBytesEq(t *testing.T) {
	if !bytesEq([]byte{1, 2, 3}, []byte{1, 2, 3}) {
		t.Fatal("equal slices should be equal")
	}
	if bytesEq([]byte{1, 2, 3}, []byte{1, 2}) {
		t.Fatal("differing lengths should not be equal")
	}
	if bytesEq([]byte{1, 2, 3}, []byte{1, 2, 4}) {
		t.Fatal("differing bytes should not be equal")
	}
}
