package dbstudio

import (
	"context"
	"testing"
	"time"
)

func TestQueryHistoryAppendList(t *testing.T) {
	db := openTestDB(t)
	store := &QueryHistoryStore{db: db}
	ctx := context.Background()
	now := time.Now()

	rc := int64(3)
	mustAppend := func(nodeID uint64, sql, status string, at time.Time) {
		t.Helper()
		if err := store.Append(ctx, QueryHistoryEntry{
			OwnerID: 1, NodeID: nodeID, SQL: sql,
			ExecutedAt: at, DurationMs: 5, RowCount: &rc, Status: status,
		}); err != nil {
			t.Fatalf("append: %v", err)
		}
	}
	mustAppend(10, "SELECT 1", "ok", now.Add(-2*time.Second))
	mustAppend(10, "SELECT 2", "ok", now.Add(-1*time.Second))
	mustAppend(20, "BAD SQL", "error", now)

	// List all for owner 1, newest first.
	all, err := store.List(ctx, 1, 0, 0, 0, time.Time{})
	if err != nil {
		t.Fatalf("list: %v", err)
	}
	if len(all) != 3 {
		t.Fatalf("len = %d, want 3", len(all))
	}
	if !all[0].ExecutedAt.After(all[1].ExecutedAt) {
		t.Fatalf("expected newest-first ordering: %+v", all)
	}

	// Filter by node.
	node10, _ := store.List(ctx, 1, 10, 0, 0, time.Time{})
	if len(node10) != 2 {
		t.Fatalf("node10 len = %d, want 2", len(node10))
	}

	// Paginate.
	page, _ := store.List(ctx, 1, 0, 1, 1, time.Time{}) // limit=1, offset=1
	if len(page) != 1 {
		t.Fatalf("page len = %d, want 1", len(page))
	}

	// since filter excludes older rows.
	recent, _ := store.List(ctx, 1, 0, 0, 0, now.Add(-1500*time.Millisecond))
	if len(recent) != 1 {
		t.Fatalf("recent len = %d, want 1 (only the latest ok)", len(recent))
	}

	// Get + Delete round out the lifecycle.
	got, err := store.Get(ctx, all[0].ID)
	if err != nil {
		t.Fatalf("get: %v", err)
	}
	if got.SQL != all[0].SQL {
		t.Fatalf("get sql mismatch")
	}
	if err := store.Delete(ctx, all[0].ID); err != nil {
		t.Fatalf("delete: %v", err)
	}
}

func TestQueryHistoryNilSafe(t *testing.T) {
	var store *QueryHistoryStore
	ctx := context.Background()
	if err := store.Append(ctx, QueryHistoryEntry{}); err != ErrUnavailable {
		t.Fatalf("nil Append err = %v", err)
	}
	if _, err := store.List(ctx, 1, 0, 0, 0, time.Time{}); err != ErrUnavailable {
		t.Fatalf("nil List err = %v", err)
	}
	if _, err := store.Get(ctx, 1); err != ErrUnavailable {
		t.Fatalf("nil Get err = %v", err)
	}
	if err := store.Delete(ctx, 1); err != ErrUnavailable {
		t.Fatalf("nil Delete err = %v", err)
	}
}
