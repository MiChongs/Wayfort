package planner

import (
	"context"
	"testing"

	"github.com/DATA-DOG/go-sqlmock"
)

// Dameng runs EXPLAIN PLAN FOR (an Exec) then reads SYS-style PLAN_TABLE rows.
// Root row carries NULL PARENT_ID; children point back at their parent's ID.
func TestDamengPlan(t *testing.T) {
	db, mock, err := sqlmock.New()
	if err != nil {
		t.Fatal(err)
	}
	defer db.Close()

	mock.ExpectExec(`EXPLAIN PLAN FOR`).
		WillReturnResult(sqlmock.NewResult(0, 0))

	rows := sqlmock.NewRows([]string{"ID", "PARENT_ID", "OPERATION", "OBJECT_NAME", "CARDINALITY", "COST"}).
		AddRow(0, nil, "SELECT STATEMENT", nil, nil, 10.0).
		AddRow(1, 0, "TABLE ACCESS", "USERS", 100, 5.0)
	mock.ExpectQuery(`FROM PLAN_TABLE`).WillReturnRows(rows)

	root, _, err := NewDameng(db).Plan(context.Background(), "SELECT * FROM users")
	if err != nil {
		t.Fatal(err)
	}
	if root == nil || root.Op != "SELECT STATEMENT" {
		t.Fatalf("root: %+v", root)
	}
	if len(root.Children) != 1 {
		t.Fatalf("want 1 child, got %d", len(root.Children))
	}
	c := root.Children[0]
	if c.Op != "TABLE ACCESS" || c.Table != "USERS" || c.Rows != 100 || c.Cost != 5.0 {
		t.Fatalf("child: %+v", c)
	}
}

func TestDamengNoDB(t *testing.T) {
	if _, _, err := NewDameng(nil).Plan(context.Background(), "SELECT 1"); err != errNoDB {
		t.Fatalf("want errNoDB, got %v", err)
	}
}
