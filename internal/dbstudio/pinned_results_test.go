package dbstudio

import (
	"context"
	"testing"
	"time"
)

func TestPinnedResultsCreateRead(t *testing.T) {
	db := openTestDB(t)
	store := &PinnedResultsStore{db: db}
	ctx := context.Background()

	rows := []map[string]any{
		{"id": 1, "name": "x"},
		{"id": 2, "name": "y"},
	}
	out, err := store.Create(ctx, PinnedResultEntry{
		OwnerID: 1, NodeID: 10, SQL: "SELECT 1",
		ExecutedAt: time.Now(), Rows: rows, TTL: time.Now().Add(24 * time.Hour),
	})
	if err != nil {
		t.Fatalf("create: %v", err)
	}
	if out.ID == 0 {
		t.Fatal("expected ID")
	}
	if out.RowCount != 2 {
		t.Fatalf("row count = %d, want 2", out.RowCount)
	}
	if out.Truncated {
		t.Fatal("small payload should not be truncated")
	}

	// Get decodes the snapshot back into Rows.
	got, err := store.Get(ctx, out.ID)
	if err != nil {
		t.Fatalf("get: %v", err)
	}
	if len(got.Rows) != 2 || got.Rows[0]["name"] != "x" {
		t.Fatalf("decoded rows: %+v", got.Rows)
	}
	if got.SQL != "SELECT 1" {
		t.Fatalf("sql = %q", got.SQL)
	}

	// List excludes Rows but keeps metadata.
	list, err := store.List(ctx, 1)
	if err != nil {
		t.Fatalf("list: %v", err)
	}
	if len(list) != 1 {
		t.Fatalf("list len = %d, want 1", len(list))
	}
	if len(list[0].Rows) != 0 {
		t.Fatalf("list should exclude Rows, got %d", len(list[0].Rows))
	}

	// Delete.
	if err := store.Delete(ctx, out.ID); err != nil {
		t.Fatalf("delete: %v", err)
	}
	if _, err := store.Get(ctx, out.ID); err == nil {
		t.Fatal("expected error after delete")
	}
}

func TestPinnedResultsNilSafe(t *testing.T) {
	var store *PinnedResultsStore
	ctx := context.Background()
	if _, err := store.Create(ctx, PinnedResultEntry{}); err != ErrUnavailable {
		t.Fatalf("nil Create err = %v", err)
	}
	if _, err := store.Get(ctx, 1); err != ErrUnavailable {
		t.Fatalf("nil Get err = %v", err)
	}
	if _, err := store.List(ctx, 1); err != ErrUnavailable {
		t.Fatalf("nil List err = %v", err)
	}
	if err := store.Delete(ctx, 1); err != ErrUnavailable {
		t.Fatalf("nil Delete err = %v", err)
	}
}
