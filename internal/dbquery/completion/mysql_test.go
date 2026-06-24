package completion

import (
	"context"
	"testing"

	"github.com/DATA-DOG/go-sqlmock"
)

func TestMySQLSnapshot(t *testing.T) {
	db, mock, err := sqlmock.New()
	if err != nil {
		t.Fatal(err)
	}
	defer db.Close()

	// schemas
	mock.ExpectQuery("SELECT schema_name FROM information_schema.schemata").
		WillReturnRows(sqlmock.NewRows([]string{"schema_name"}).
			AddRow("public").AddRow("test"))
	// tables
	mock.ExpectQuery("SELECT table_schema, table_name, table_type FROM information_schema.tables").
		WillReturnRows(sqlmock.NewRows([]string{"table_schema", "table_name", "table_type"}).
			AddRow("public", "users", "BASE TABLE").
			AddRow("public", "v_active_users", "VIEW"))
	// columns
	mock.ExpectQuery("SELECT table_schema, table_name, column_name, data_type, is_nullable FROM information_schema.columns").
		WillReturnRows(sqlmock.NewRows([]string{"table_schema", "table_name", "column_name", "data_type", "is_nullable"}).
			AddRow("public", "users", "id", "bigint", "NO").
			AddRow("public", "users", "email", "varchar", "YES"))
	// functions
	mock.ExpectQuery("SELECT routine_schema, routine_name, data_type FROM information_schema.routines").
		WillReturnRows(sqlmock.NewRows([]string{"routine_schema", "routine_name", "data_type"}).
			AddRow("public", "uuid_v7", "varchar"))

	p := NewMySQL(db)
	snap, err := p.Snapshot(context.Background(), "test_db")
	if err != nil {
		t.Fatal(err)
	}
	if snap.Database != "test_db" {
		t.Fatalf("database: %q", snap.Database)
	}
	if len(snap.Schemas) != 2 {
		t.Fatalf("schemas: %v", snap.Schemas)
	}
	if len(snap.Tables) != 2 {
		t.Fatalf("tables: %d", len(snap.Tables))
	}
	users := snap.Tables[0]
	if users.Name != "users" || len(users.Columns) != 2 || users.Columns[0].Name != "id" {
		t.Fatalf("users: %+v", users)
	}
	if !users.Columns[1].Nullable {
		t.Fatal("email should be nullable")
	}
	if len(snap.Functions) != 1 {
		t.Fatalf("functions: %d", len(snap.Functions))
	}
}

func TestMySQLKeywords(t *testing.T) {
	p := NewMySQL(nil)
	kw := p.Keywords(context.Background())
	if len(kw) < 20 {
		t.Fatal("expected ≥20 keywords")
	}
}
