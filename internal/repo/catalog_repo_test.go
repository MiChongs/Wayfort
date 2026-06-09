package repo

import (
	"context"
	"fmt"
	"testing"

	"github.com/michongs/jumpserver-anonymous/internal/model"
	"gorm.io/driver/sqlite"
	"gorm.io/gorm"
)

func newCatalogTestDB(t *testing.T) *gorm.DB {
	t.Helper()
	db, err := gorm.Open(sqlite.Open(":memory:"), &gorm.Config{})
	if err != nil {
		t.Fatalf("open sqlite: %v", err)
	}
	if err := db.AutoMigrate(&model.Catalog{}, &model.CatalogFolder{}, &model.CatalogPlacement{}, &model.CatalogAssignment{}); err != nil {
		t.Fatalf("migrate: %v", err)
	}
	return db
}

func mkFolder(t *testing.T, fr *CatalogFolderRepo, catID uint64, name string, parent *uint64) *model.CatalogFolder {
	t.Helper()
	f := &model.CatalogFolder{CatalogID: catID, Name: name, ParentID: parent}
	if err := fr.Create(context.Background(), f); err != nil {
		t.Fatalf("create folder %s: %v", name, err)
	}
	return f
}

func reload(t *testing.T, fr *CatalogFolderRepo, id uint64) *model.CatalogFolder {
	t.Helper()
	f, err := fr.FindByID(context.Background(), id)
	if err != nil || f == nil {
		t.Fatalf("reload folder %d: %v", id, err)
	}
	return f
}

func TestCatalogFolderPathAndMove(t *testing.T) {
	db := newCatalogTestDB(t)
	ctx := context.Background()
	cr, fr := NewCatalogRepo(db), NewCatalogFolderRepo(db)

	cat := &model.Catalog{Name: "c1"}
	if err := cr.Create(ctx, cat); err != nil {
		t.Fatal(err)
	}
	a := mkFolder(t, fr, cat.ID, "A", nil)
	b := mkFolder(t, fr, cat.ID, "B", &a.ID)
	c := mkFolder(t, fr, cat.ID, "C", &b.ID)

	// Materialised paths chain by id.
	if got := reload(t, fr, a.ID).Path; got != fmt.Sprint(a.ID) {
		t.Fatalf("A path = %q", got)
	}
	if got, want := reload(t, fr, b.ID).Path, fmt.Sprintf("%d/%d", a.ID, b.ID); got != want {
		t.Fatalf("B path = %q want %q", got, want)
	}
	if got, want := reload(t, fr, c.ID).Path, fmt.Sprintf("%d/%d/%d", a.ID, b.ID, c.ID); got != want {
		t.Fatalf("C path = %q want %q", got, want)
	}

	// Cycle: moving A under its descendant C must fail.
	if err := fr.Move(ctx, a.ID, &c.ID); err == nil {
		t.Fatal("expected cycle move to fail")
	}
	// Moving onto self must fail.
	if err := fr.Move(ctx, a.ID, &a.ID); err == nil {
		t.Fatal("expected self move to fail")
	}

	// Move B to root → B and its subtree (C) get rewritten.
	if err := fr.Move(ctx, b.ID, nil); err != nil {
		t.Fatalf("move B to root: %v", err)
	}
	if got, want := reload(t, fr, b.ID).Path, fmt.Sprint(b.ID); got != want {
		t.Fatalf("B path after move = %q want %q", got, want)
	}
	if got, want := reload(t, fr, c.ID).Path, fmt.Sprintf("%d/%d", b.ID, c.ID); got != want {
		t.Fatalf("C path after move = %q want %q (descendant not rewritten)", got, want)
	}
	if reload(t, fr, c.ID).ParentID == nil || *reload(t, fr, c.ID).ParentID != b.ID {
		t.Fatal("C parent should still be B")
	}
}

func TestCatalogFolderDeleteSubtreeCascade(t *testing.T) {
	db := newCatalogTestDB(t)
	ctx := context.Background()
	cr, fr := NewCatalogRepo(db), NewCatalogFolderRepo(db)
	pr, ar := NewCatalogPlacementRepo(db), NewCatalogAssignmentRepo(db)

	cat := &model.Catalog{Name: "c1"}
	if err := cr.Create(ctx, cat); err != nil {
		t.Fatal(err)
	}
	a := mkFolder(t, fr, cat.ID, "A", nil)
	b := mkFolder(t, fr, cat.ID, "B", &a.ID)
	c := mkFolder(t, fr, cat.ID, "C", &b.ID)

	if err := pr.Add(ctx, cat.ID, a.ID, 100); err != nil {
		t.Fatal(err)
	}
	if err := pr.Add(ctx, cat.ID, b.ID, 200); err != nil {
		t.Fatal(err)
	}
	if err := pr.Add(ctx, cat.ID, c.ID, 300); err != nil {
		t.Fatal(err)
	}
	// Whole-catalog assignment + one scoped to B.
	if err := ar.Create(ctx, &model.CatalogAssignment{CatalogID: cat.ID, GranteeType: model.GranteeUser, GranteeID: 1, Actions: "connect"}); err != nil {
		t.Fatal(err)
	}
	if err := ar.Create(ctx, &model.CatalogAssignment{CatalogID: cat.ID, FolderID: &b.ID, GranteeType: model.GranteeUser, GranteeID: 2, Actions: "connect"}); err != nil {
		t.Fatal(err)
	}

	// Delete B → B and C gone (no child promotion), A survives.
	if err := fr.Delete(ctx, b.ID); err != nil {
		t.Fatalf("delete B: %v", err)
	}
	folders, _ := fr.ListByCatalog(ctx, cat.ID)
	if len(folders) != 1 || folders[0].ID != a.ID {
		t.Fatalf("after delete, folders = %+v, want only A", folders)
	}
	// Placements under B and C gone; A's placement (100) remains.
	nodes, _ := pr.NodesInCatalog(ctx, cat.ID)
	if len(nodes) != 1 || nodes[0] != 100 {
		t.Fatalf("nodes after delete = %v, want [100]", nodes)
	}
	// Assignment scoped to B gone; whole-catalog assignment remains.
	assigns, _ := ar.ListByCatalog(ctx, cat.ID)
	if len(assigns) != 1 || assigns[0].FolderID != nil {
		t.Fatalf("assignments after delete = %+v, want only the whole-catalog one", assigns)
	}
}

func TestCatalogSubtreePrefixSafety(t *testing.T) {
	db := newCatalogTestDB(t)
	ctx := context.Background()
	fr := NewCatalogFolderRepo(db)

	// Hand-craft paths "12" and "120" so the prefix bug (LIKE '12%') would
	// wrongly match 120. Subtree must return only folder 12.
	if err := db.Create(&model.CatalogFolder{ID: 12, CatalogID: 1, Name: "twelve", Path: "12"}).Error; err != nil {
		t.Fatal(err)
	}
	if err := db.Create(&model.CatalogFolder{ID: 120, CatalogID: 1, Name: "onetwenty", Path: "120"}).Error; err != nil {
		t.Fatal(err)
	}
	if err := db.Create(&model.CatalogFolder{ID: 13, CatalogID: 1, Name: "child", Path: "12/13"}).Error; err != nil {
		t.Fatal(err)
	}
	sub, err := fr.Subtree(ctx, 1, "12")
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

func TestCatalogPlacementsDedupAndPurge(t *testing.T) {
	db := newCatalogTestDB(t)
	ctx := context.Background()
	cr, fr := NewCatalogRepo(db), NewCatalogFolderRepo(db)
	pr := NewCatalogPlacementRepo(db)

	cat := &model.Catalog{Name: "c1"}
	if err := cr.Create(ctx, cat); err != nil {
		t.Fatal(err)
	}
	a := mkFolder(t, fr, cat.ID, "A", nil)
	b := mkFolder(t, fr, cat.ID, "B", nil)

	// Same node 100 placed in two folders (placements are non-unique).
	if err := pr.Add(ctx, cat.ID, a.ID, 100); err != nil {
		t.Fatal(err)
	}
	if err := pr.Add(ctx, cat.ID, b.ID, 100); err != nil {
		t.Fatal(err)
	}
	// Re-adding to the same folder is idempotent.
	if err := pr.Add(ctx, cat.ID, a.ID, 100); err != nil {
		t.Fatal(err)
	}
	if err := pr.Add(ctx, cat.ID, b.ID, 200); err != nil {
		t.Fatal(err)
	}

	if nodes, _ := pr.NodesInCatalog(ctx, cat.ID); len(nodes) != 2 {
		t.Fatalf("NodesInCatalog = %v, want 2 distinct (100,200)", nodes)
	}
	if nodes, _ := pr.NodesInFolders(ctx, []uint64{a.ID}); len(nodes) != 1 || nodes[0] != 100 {
		t.Fatalf("NodesInFolders(A) = %v, want [100]", nodes)
	}
	all, _ := pr.ListByCatalog(ctx, cat.ID)
	if len(all) != 3 {
		t.Fatalf("placement rows = %d, want 3 (100 in A, 100 in B, 200 in B)", len(all))
	}

	// PurgeNode drops 100 from every folder.
	if err := pr.PurgeNode(ctx, 100); err != nil {
		t.Fatal(err)
	}
	if nodes, _ := pr.NodesInCatalog(ctx, cat.ID); len(nodes) != 1 || nodes[0] != 200 {
		t.Fatalf("after purge NodesInCatalog = %v, want [200]", nodes)
	}
}
