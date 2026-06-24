package planner

import (
	"context"
	"testing"

	"github.com/DATA-DOG/go-sqlmock"
)

// PG returns EXPLAIN (FORMAT JSON) as one row whose single column is a JSON
// array: [{"Plan": {...}}]. We mirror that shape verbatim.
func TestPostgresPlan(t *testing.T) {
	db, mock, err := sqlmock.New()
	if err != nil {
		t.Fatal(err)
	}
	defer db.Close()

	const pgJSON = `[{"Plan":{` +
		`"Node Type":"Seq Scan",` +
		`"Relation Name":"users",` +
		`"Startup Cost":0,` +
		`"Total Cost":12.5,` +
		`"Plan Rows":100,` +
		`"Plan Width":4,` +
		`"Plans":[{` +
		`"Node Type":"Index Scan",` +
		`"Relation Name":"users_email_idx",` +
		`"Startup Cost":0,` +
		`"Total Cost":5,` +
		`"Plan Rows":1,` +
		`"Plan Width":0` +
		`}]}}]`

	// Parens are regex metachars to sqlmock's default regexp matcher.
	mock.ExpectQuery(`EXPLAIN \(FORMAT JSON\)`).
		WillReturnRows(sqlmock.NewRows([]string{"QUERY PLAN"}).AddRow(pgJSON))

	root, raw, err := NewPostgres(db).Plan(context.Background(), "SELECT * FROM users")
	if err != nil {
		t.Fatal(err)
	}
	if root == nil || root.Op != "Seq Scan" {
		t.Fatalf("root: %+v", root)
	}
	if root.Table != "users" || root.Rows != 100 || root.Cost != 12.5 || root.Width != 4 {
		t.Fatalf("root fields: %+v", root)
	}
	if len(root.Children) != 1 {
		t.Fatalf("want 1 child, got %d", len(root.Children))
	}
	c := root.Children[0]
	if c.Op != "Index Scan" || c.Table != "users_email_idx" || c.Rows != 1 || c.Cost != 5 {
		t.Fatalf("child: %+v", c)
	}
	if raw == "" {
		t.Fatal("expected raw JSON payload")
	}
}

func TestPostgresNoDB(t *testing.T) {
	if _, _, err := NewPostgres(nil).Plan(context.Background(), "SELECT 1"); err != errNoDB {
		t.Fatalf("want errNoDB, got %v", err)
	}
}
