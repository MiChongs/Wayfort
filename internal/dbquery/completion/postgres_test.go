package completion

import (
	"context"
	"testing"

	"github.com/DATA-DOG/go-sqlmock"
)

func TestPostgresSnapshot(t *testing.T) {
	db, mock, err := sqlmock.New()
	if err != nil {
		t.Fatal(err)
	}
	defer db.Close()

	mock.ExpectQuery("SELECT schema_name FROM information_schema.schemata").
		WillReturnRows(sqlmock.NewRows([]string{"schema_name"}).AddRow("public"))
	mock.ExpectQuery("SELECT table_schema, table_name, table_type FROM information_schema.tables").
		WillReturnRows(sqlmock.NewRows([]string{"table_schema", "table_name", "table_type"}).
			AddRow("public", "accounts", "BASE TABLE"))
	mock.ExpectQuery("SELECT table_schema, table_name, column_name, data_type, is_nullable").
		WillReturnRows(sqlmock.NewRows([]string{"table_schema", "table_name", "column_name", "data_type", "is_nullable"}).
			AddRow("public", "accounts", "id", "bigint", "NO"))
	mock.ExpectQuery("SELECT routine_schema, routine_name, data_type FROM information_schema.routines").
		WillReturnRows(sqlmock.NewRows([]string{"routine_schema", "routine_name", "data_type"}).
			AddRow("public", "gen_random_uuid", "uuid"))

	snap, err := NewPostgres(db).Snapshot(context.Background(), "appdb")
	if err != nil {
		t.Fatal(err)
	}
	if len(snap.Tables) != 1 || snap.Tables[0].Name != "accounts" {
		t.Fatalf("tables: %+v", snap.Tables)
	}
}
