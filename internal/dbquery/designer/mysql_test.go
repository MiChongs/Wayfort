package designer

import (
	"context"
	"os"
	"path/filepath"
	"testing"
)

func TestMySQLRenderTable_Create(t *testing.T) {
	d := NewMySQL()
	spec := TableSpec{
		Schema: "public", Name: "users",
		Columns: []ColumnSpec{
			{Name: "id", DataType: "BIGINT", Nullable: false, AutoIncrement: true},
			{Name: "email", DataType: "VARCHAR(255)", Nullable: false, Comment: "user login email"},
			{Name: "created_at", DataType: "TIMESTAMP", Nullable: false},
		},
		PrimaryKey: []string{"id"},
		Engine:     "InnoDB", Charset: "utf8mb4",
		Comment: "application users",
	}
	got, err := d.RenderTable(context.Background(), spec)
	if err != nil {
		t.Fatal(err)
	}
	want := mustReadGolden(t, "mysql/table_create.sql")
	if got != want {
		t.Fatalf("RenderTable mismatch.\ngot:\n%s\nwant:\n%s", got, want)
	}
}

// mustReadGolden reads a golden file relative to testdata/. Shared by all
// dialect *_test.go files.
func mustReadGolden(t *testing.T, rel string) string {
	t.Helper()
	b, err := os.ReadFile(filepath.Join("testdata", rel))
	if err != nil {
		t.Fatal(err)
	}
	return string(b)
}
