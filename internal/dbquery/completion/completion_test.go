package completion

import "testing"

func TestSnapshotEmpty(t *testing.T) {
	var s Snapshot
	if len(s.Tables) != 0 {
		t.Fatal("empty snapshot must have no tables")
	}
}
