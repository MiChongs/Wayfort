package planner

import (
	"context"
	"testing"

	"github.com/DATA-DOG/go-sqlmock"
)

func TestMySQLPlanTree(t *testing.T) {
	db, mock, err := sqlmock.New()
	if err != nil {
		t.Fatal(err)
	}
	defer db.Close()

	// EXPLAIN FORMAT=TREE
	treeRows := sqlmock.NewRows([]string{"EXPLAIN"}).AddRow(
		"-> Sort: u.id  (cost=4.50)\n    -> Filter: (u.active = true)  (cost=3.00 rows=10)\n        -> Table scan on users  (cost=2.00 rows=100)\n",
	)
	mock.ExpectQuery("EXPLAIN FORMAT=TREE").WillReturnRows(treeRows)

	// EXPLAIN FORMAT=JSON
	mock.ExpectQuery("EXPLAIN FORMAT=JSON").
		WillReturnRows(sqlmock.NewRows([]string{"EXPLAIN"}).AddRow(`{"query_block":{"select_id":1}}`))

	root, raw, err := NewMySQL(db).Plan(context.Background(), "SELECT * FROM users")
	if err != nil {
		t.Fatal(err)
	}
	if root == nil || root.Op == "" {
		t.Fatal("expected root node")
	}
	if raw == "" {
		t.Fatal("expected raw text")
	}
}

// TestMySQLNoDB exercises the nil-db guard on the public Plan method.
func TestMySQLNoDB(t *testing.T) {
	if _, _, err := NewMySQL(nil).Plan(context.Background(), "SELECT 1"); err != errNoDB {
		t.Fatalf("want errNoDB, got %v", err)
	}
}

// TestParseTreeNesting targets the indentation-driven stack algorithm in
// parseTree (two siblings under one parent) without going through sqlmock.
func TestParseTreeNesting(t *testing.T) {
	tree := "-> Hash Join  (cost=10)\n" +
		"    -> Seq Scan on a  (cost=2 rows=5)\n" +
		"    -> Seq Scan on b  (cost=3 rows=8)\n"
	root := parseTree(tree)
	if root == nil || root.Op != "Hash Join" {
		t.Fatalf("root: %+v", root)
	}
	if len(root.Children) != 2 {
		t.Fatalf("want 2 children, got %d (%+v)", len(root.Children), root.Children)
	}
	if root.Children[0].Op != "Seq Scan on a" || root.Children[1].Op != "Seq Scan on b" {
		t.Fatalf("children: %+v", root.Children)
	}
	if root.Cost != 10 || root.Children[0].Rows != 5 {
		t.Fatalf("cost/rows not parsed: %+v", root)
	}
}
