package dbstudio

import (
	"bytes"
	"compress/gzip"
	"encoding/json"
)

// snapshotMaxRows / snapshotMaxBytes cap a pinned-result snapshot so a
// runaway query can't balloon the row or blow past the LONGBLOB budget.
const (
	snapshotMaxRows  = 50_000
	snapshotMaxBytes = 10 * 1024 * 1024 // 10 MB compressed
)

// SnapshotEncode serializes rows as gzipped JSON. It returns
// (blob, truncated, err): truncated is true when the payload was clipped
// to fit the row or byte budget. Errors only on JSON marshal / gzip
// failure (both effectively impossible for map[string]any input).
//
// The byte budget is enforced by bisecting the row slice — re-encoding
// prefixes until the gzipped size lands under the cap — so truncation is
// exact rather than "the last attempt that fit".
func SnapshotEncode(rows []map[string]any) ([]byte, bool, error) {
	truncated := false
	if len(rows) > snapshotMaxRows {
		rows = rows[:snapshotMaxRows]
		truncated = true
	}
	raw, err := json.Marshal(rows)
	if err != nil {
		return nil, false, err
	}
	var buf bytes.Buffer
	zw := gzip.NewWriter(&buf)
	if _, err := zw.Write(raw); err != nil {
		return nil, false, err
	}
	if err := zw.Close(); err != nil {
		return nil, false, err
	}
	if buf.Len() > snapshotMaxBytes {
		// Bisect rows until under budget.
		lo, hi := 0, len(rows)
		for lo < hi {
			mid := (lo + hi + 1) / 2
			raw2, _ := json.Marshal(rows[:mid])
			var b2 bytes.Buffer
			w2 := gzip.NewWriter(&b2)
			_, _ = w2.Write(raw2)
			_ = w2.Close()
			if b2.Len() <= snapshotMaxBytes {
				lo = mid
			} else {
				hi = mid - 1
			}
		}
		rows = rows[:lo]
		truncated = true
		raw, _ = json.Marshal(rows)
		buf.Reset()
		zw = gzip.NewWriter(&buf)
		_, _ = zw.Write(raw)
		_ = zw.Close()
	}
	return buf.Bytes(), truncated, nil
}

// SnapshotDecode reverses SnapshotEncode. Empty input → empty (nil) rows.
func SnapshotDecode(blob []byte) ([]map[string]any, error) {
	if len(blob) == 0 {
		return nil, nil
	}
	zr, err := gzip.NewReader(bytes.NewReader(blob))
	if err != nil {
		return nil, err
	}
	defer zr.Close()
	var rows []map[string]any
	if err := json.NewDecoder(zr).Decode(&rows); err != nil {
		return nil, err
	}
	return rows, nil
}
