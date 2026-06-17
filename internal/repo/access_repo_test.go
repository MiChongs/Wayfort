package repo

import (
	"context"
	"fmt"
	"testing"

	"github.com/michongs/wayfort/internal/model"
	"gorm.io/driver/sqlite"
	"gorm.io/gorm"
)

func newAccessTestDB(t *testing.T) *gorm.DB {
	t.Helper()
	db, err := gorm.Open(sqlite.Open(":memory:"), &gorm.Config{})
	if err != nil {
		t.Fatalf("open sqlite: %v", err)
	}
	if err := db.AutoMigrate(&model.AccessFolder{}, &model.AccessItem{}); err != nil {
		t.Fatalf("migrate: %v", err)
	}
	return db
}

func mkAccFolder(t *testing.T, fr *AccessFolderRepo, owner uint64, name string, parent *uint64) *model.AccessFolder {
	t.Helper()
	f := &model.AccessFolder{OwnerType: model.GranteeUser, OwnerID: owner, Name: name, ParentID: parent}
	if err := fr.Create(context.Background(), f); err != nil {
		t.Fatalf("create folder %s: %v", name, err)
	}
	return f
}

func reloadAcc(t *testing.T, fr *AccessFolderRepo, id uint64) *model.AccessFolder {
	t.Helper()
	f, err := fr.FindByID(context.Background(), id)
	if err != nil || f == nil {
		t.Fatalf("reload folder %d: %v", id, err)
	}
	return f
}

func TestAccessFolderPathAndMove(t *testing.T) {
	db := newAccessTestDB(t)
	ctx := context.Background()
	fr := NewAccessFolderRepo(db)

	a := mkAccFolder(t, fr, 1, "A", nil)
	b := mkAccFolder(t, fr, 1, "B", &a.ID)
	c := mkAccFolder(t, fr, 1, "C", &b.ID)

	if got, want := reloadAcc(t, fr, c.ID).Path, fmt.Sprintf("%d/%d/%d", a.ID, b.ID, c.ID); got != want {
		t.Fatalf("C path = %q want %q", got, want)
	}
	// Cycle / self moves rejected.
	if err := fr.Move(ctx, a.ID, &c.ID); err == nil {
		t.Fatal("expected cycle move to fail")
	}
	if err := fr.Move(ctx, a.ID, &a.ID); err == nil {
		t.Fatal("expected self move to fail")
	}
	// Move B to root → descendant C rewritten.
	if err := fr.Move(ctx, b.ID, nil); err != nil {
		t.Fatalf("move B: %v", err)
	}
	if got, want := reloadAcc(t, fr, c.ID).Path, fmt.Sprintf("%d/%d", b.ID, c.ID); got != want {
		t.Fatalf("C path after move = %q want %q", got, want)
	}
}

func TestAccessFolderDeleteSubtree(t *testing.T) {
	db := newAccessTestDB(t)
	ctx := context.Background()
	fr, ir := NewAccessFolderRepo(db), NewAccessItemRepo(db)

	a := mkAccFolder(t, fr, 1, "A", nil)
	b := mkAccFolder(t, fr, 1, "B", &a.ID)
	c := mkAccFolder(t, fr, 1, "C", &b.ID)
	for _, v := range []struct {
		f, n uint64
	}{{a.ID, 100}, {b.ID, 200}, {c.ID, 300}} {
		if err := ir.Add(ctx, &model.AccessItem{OwnerType: model.GranteeUser, OwnerID: 1, FolderID: v.f, NodeID: v.n}); err != nil {
			t.Fatal(err)
		}
	}
	if err := fr.Delete(ctx, b.ID); err != nil {
		t.Fatalf("delete B: %v", err)
	}
	folders, _ := fr.ListByOwner(ctx, model.GranteeUser, 1)
	if len(folders) != 1 || folders[0].ID != a.ID {
		t.Fatalf("folders after delete = %+v, want only A", folders)
	}
	items, _ := ir.ListByOwner(ctx, model.GranteeUser, 1)
	if len(items) != 1 || items[0].NodeID != 100 {
		t.Fatalf("items after delete = %+v, want only node 100", items)
	}
}

func TestAccessSubtreePrefixSafety(t *testing.T) {
	db := newAccessTestDB(t)
	ctx := context.Background()
	fr := NewAccessFolderRepo(db)
	// Hand-craft "12" and "120" so a naive LIKE '12%' would wrongly match 120.
	for _, f := range []model.AccessFolder{
		{ID: 12, OwnerType: model.GranteeUser, OwnerID: 1, Name: "twelve", Path: "12"},
		{ID: 120, OwnerType: model.GranteeUser, OwnerID: 1, Name: "onetwenty", Path: "120"},
		{ID: 13, OwnerType: model.GranteeUser, OwnerID: 1, Name: "child", Path: "12/13"},
	} {
		if err := db.Create(&f).Error; err != nil {
			t.Fatal(err)
		}
	}
	sub, err := fr.Subtree(ctx, model.GranteeUser, 1, "12")
	if err != nil {
		t.Fatal(err)
	}
	got := map[uint64]bool{}
	for _, f := range sub {
		got[f.ID] = true
	}
	if !got[12] || !got[13] || got[120] || len(sub) != 2 {
		t.Fatalf("subtree(12) = %+v, want {12,13} and NOT 120", sub)
	}
}

func TestAccessItemAddAndPurge(t *testing.T) {
	db := newAccessTestDB(t)
	ctx := context.Background()
	fr, ir := NewAccessFolderRepo(db), NewAccessItemRepo(db)
	a := mkAccFolder(t, fr, 1, "A", nil)
	b := mkAccFolder(t, fr, 1, "B", nil)

	add := func(folder, node uint64) {
		if err := ir.Add(ctx, &model.AccessItem{OwnerType: model.GranteeUser, OwnerID: 1, FolderID: folder, NodeID: node}); err != nil {
			t.Fatal(err)
		}
	}
	add(a.ID, 100)
	add(b.ID, 100) // same node, different folder — allowed
	add(a.ID, 100) // idempotent within (folder,node)
	add(b.ID, 200)

	items, _ := ir.ListByOwner(ctx, model.GranteeUser, 1)
	if len(items) != 3 {
		t.Fatalf("items = %d, want 3 (100@A, 100@B, 200@B)", len(items))
	}
	byNode, _ := ir.ListByNode(ctx, 100)
	if len(byNode) != 2 {
		t.Fatalf("ListByNode(100) = %d, want 2", len(byNode))
	}
	if err := ir.PurgeNode(ctx, 100); err != nil {
		t.Fatal(err)
	}
	items, _ = ir.ListByOwner(ctx, model.GranteeUser, 1)
	if len(items) != 1 || items[0].NodeID != 200 {
		t.Fatalf("after purge items = %+v, want only 200", items)
	}
}
