package dbstudio

import (
	"bytes"
	"testing"
)

func TestSnapshotRoundtrip(t *testing.T) {
	rows := []map[string]any{
		{"id": 1, "name": "alice"},
		{"id": 2, "name": "bob", "active": true},
	}
	blob, truncated, err := SnapshotEncode(rows)
	if err != nil {
		t.Fatalf("encode: %v", err)
	}
	if truncated {
		t.Fatalf("small payload should not be truncated")
	}
	if len(blob) == 0 {
		t.Fatal("expected non-empty blob")
	}
	// A gzip stream always starts with 0x1f 0x8b — sanity check it really
	// is gzipped, not raw JSON.
	if !bytes.HasPrefix(blob, []byte{0x1f, 0x8b}) {
		t.Fatalf("blob is not a gzip stream: % x", blob[:2])
	}
	got, err := SnapshotDecode(blob)
	if err != nil {
		t.Fatalf("decode: %v", err)
	}
	if len(got) != 2 {
		t.Fatalf("rows = %d, want 2", len(got))
	}
	if got[0]["name"] != "alice" || got[1]["name"] != "bob" {
		t.Fatalf("decoded rows mismatch: %+v", got)
	}
}

func TestSnapshotDecodeEmpty(t *testing.T) {
	got, err := SnapshotDecode(nil)
	if err != nil {
		t.Fatalf("decode nil: %v", err)
	}
	if got != nil {
		t.Fatalf("expected nil for empty input, got %v", got)
	}
}

func TestSnapshotTruncationByRows(t *testing.T) {
	rows := make([]map[string]any, snapshotMaxRows+10)
	for i := range rows {
		rows[i] = map[string]any{"i": i}
	}
	_, truncated, err := SnapshotEncode(rows)
	if err != nil {
		t.Fatalf("encode: %v", err)
	}
	if !truncated {
		t.Fatal("expected truncated=true when rows exceed snapshotMaxRows")
	}
	// The encoded payload should decode back to exactly snapshotMaxRows.
	blob, _, _ := SnapshotEncode(rows)
	got, err := SnapshotDecode(blob)
	if err != nil {
		t.Fatalf("decode: %v", err)
	}
	if len(got) != snapshotMaxRows {
		t.Fatalf("decoded rows = %d, want %d", len(got), snapshotMaxRows)
	}
}
