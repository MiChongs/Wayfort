package dbstudio

import (
	"context"
	"testing"

	"gorm.io/driver/sqlite"
	"gorm.io/gorm"

	"github.com/michongs/wayfort/internal/model"
)

// openTestDB opens an in-memory sqlite DB and auto-migrates every dbstudio
// table. Shared across the dbstudio store tests; t.Skipf keeps the suite
// green on hosts without the CGO-built sqlite driver (the Phase 1.5 pattern).
func openTestDB(t *testing.T) *gorm.DB {
	t.Helper()
	db, err := gorm.Open(sqlite.Open(":memory:"), &gorm.Config{})
	if err != nil {
		t.Skipf("sqlite unavailable: %v", err)
	}
	if err := db.AutoMigrate(
		&model.SavedQuery{}, &model.QueryHistory{},
		&model.PinnedResult{}, &model.ViewProfile{},
	); err != nil {
		t.Fatalf("migrate: %v", err)
	}
	return db
}

func TestSavedQueriesCRUD(t *testing.T) {
	db := openTestDB(t)
	store := &SavedQueriesStore{db: db}
	ctx := context.Background()

	created, err := store.Create(ctx, SavedQuery{
		OwnerID: 1, Name: "All Users", FolderPath: "shared",
		SQL: "SELECT * FROM users", SharedScope: "team",
	})
	if err != nil {
		t.Fatalf("create: %v", err)
	}
	if created.ID == 0 {
		t.Fatal("expected non-zero ID after create")
	}
	if created.Name != "All Users" {
		t.Fatalf("name = %q", created.Name)
	}

	got, err := store.Get(ctx, created.ID)
	if err != nil {
		t.Fatalf("get: %v", err)
	}
	if got.SQL != "SELECT * FROM users" {
		t.Fatalf("sql = %q", got.SQL)
	}

	// List returns the owner's queries.
	list, err := store.List(ctx, 1)
	if err != nil {
		t.Fatalf("list: %v", err)
	}
	if len(list) != 1 {
		t.Fatalf("list len = %d, want 1", len(list))
	}
	// Another owner sees nothing.
	other, _ := store.List(ctx, 2)
	if len(other) != 0 {
		t.Fatalf("other owner list len = %d, want 0", len(other))
	}

	// Update.
	updated, err := store.Update(ctx, SavedQuery{
		ID: created.ID, OwnerID: 1, Name: "All Users v2",
		SQL: "SELECT id FROM users", SharedScope: "user",
	})
	if err != nil {
		t.Fatalf("update: %v", err)
	}
	if updated.Name != "All Users v2" {
		t.Fatalf("updated name = %q", updated.Name)
	}

	// Delete.
	if err := store.Delete(ctx, created.ID); err != nil {
		t.Fatalf("delete: %v", err)
	}
	if _, err := store.Get(ctx, created.ID); err == nil {
		t.Fatal("expected error after delete")
	}
}

func TestSavedQueriesCreateValidation(t *testing.T) {
	db := openTestDB(t)
	store := &SavedQueriesStore{db: db}
	ctx := context.Background()
	if _, err := store.Create(ctx, SavedQuery{OwnerID: 1}); err == nil {
		t.Fatal("expected error for missing Name/SQL")
	}
	if _, err := store.Update(ctx, SavedQuery{}); err == nil {
		t.Fatal("expected error for update without ID")
	}
}

func TestSavedQueriesNilSafe(t *testing.T) {
	var store *SavedQueriesStore // nil receiver
	ctx := context.Background()
	if _, err := store.List(ctx, 1); err != ErrUnavailable {
		t.Fatalf("nil List err = %v, want ErrUnavailable", err)
	}
	if _, err := store.Get(ctx, 1); err != ErrUnavailable {
		t.Fatalf("nil Get err = %v, want ErrUnavailable", err)
	}
	if _, err := store.Create(ctx, SavedQuery{}); err != ErrUnavailable {
		t.Fatalf("nil Create err = %v, want ErrUnavailable", err)
	}
	// Unwired (db==nil) store is also nil-safe.
	zero := &SavedQueriesStore{}
	if err := zero.Delete(ctx, 1); err != ErrUnavailable {
		t.Fatalf("zero Delete err = %v, want ErrUnavailable", err)
	}
}
