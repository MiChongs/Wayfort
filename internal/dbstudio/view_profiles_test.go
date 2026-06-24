package dbstudio

import (
	"context"
	"testing"
)

func TestViewProfilesCRUD(t *testing.T) {
	db := openTestDB(t)
	store := &ViewProfilesStore{db: db}
	ctx := context.Background()

	created, err := store.Create(ctx, ViewProfile{
		OwnerID: 1, NodeID: 10, TableFQN: "public.users", Name: "Default",
		ColumnsJSON: `["id","name"]`,
	})
	if err != nil {
		t.Fatalf("create: %v", err)
	}
	if created.ID == 0 {
		t.Fatal("expected ID")
	}

	// Second profile on the same table.
	second, _ := store.Create(ctx, ViewProfile{
		OwnerID: 1, NodeID: 10, TableFQN: "public.users", Name: "Compact",
	})

	// List scoped to (owner, node, table).
	list, err := store.List(ctx, 1, 10, "public.users")
	if err != nil {
		t.Fatalf("list: %v", err)
	}
	if len(list) != 2 {
		t.Fatalf("list len = %d, want 2", len(list))
	}
	// A different table returns nothing.
	other, _ := store.List(ctx, 1, 10, "public.orders")
	if len(other) != 0 {
		t.Fatalf("other table len = %d, want 0", len(other))
	}

	// SetDefault flips the flag and clears the sibling.
	if err := store.SetDefault(ctx, second.ID); err != nil {
		t.Fatalf("set default: %v", err)
	}
	again, _ := store.Get(ctx, created.ID)
	if again.IsDefault {
		t.Fatal("first profile should no longer be default")
	}
	def, _ := store.Get(ctx, second.ID)
	if !def.IsDefault {
		t.Fatal("second profile should now be default")
	}

	// Update.
	updated, err := store.Update(ctx, ViewProfile{
		ID: created.ID, OwnerID: 1, NodeID: 10,
		TableFQN: "public.users", Name: "Default v2",
	})
	if err != nil {
		t.Fatalf("update: %v", err)
	}
	if updated.Name != "Default v2" {
		t.Fatalf("name = %q", updated.Name)
	}

	// Delete.
	if err := store.Delete(ctx, created.ID); err != nil {
		t.Fatalf("delete: %v", err)
	}
}

func TestViewProfilesCreateValidation(t *testing.T) {
	db := openTestDB(t)
	store := &ViewProfilesStore{db: db}
	ctx := context.Background()
	if _, err := store.Create(ctx, ViewProfile{OwnerID: 1, NodeID: 1}); err == nil {
		t.Fatal("expected error for missing TableFQN/Name")
	}
}

func TestViewProfilesNilSafe(t *testing.T) {
	var store *ViewProfilesStore
	ctx := context.Background()
	if _, err := store.List(ctx, 1, 1, "t"); err != ErrUnavailable {
		t.Fatalf("nil List err = %v", err)
	}
	if _, err := store.Get(ctx, 1); err != ErrUnavailable {
		t.Fatalf("nil Get err = %v", err)
	}
	if _, err := store.Create(ctx, ViewProfile{}); err != ErrUnavailable {
		t.Fatalf("nil Create err = %v", err)
	}
	if err := store.SetDefault(ctx, 1); err != ErrUnavailable {
		t.Fatalf("nil SetDefault err = %v", err)
	}
}
