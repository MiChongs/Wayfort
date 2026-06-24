package designer

import (
	"context"
	"testing"
)

func TestPostgresRenderTable_Create(t *testing.T) {
	d := NewPostgres()
	spec := TableSpec{
		Schema: "public", Name: "users",
		Columns: []ColumnSpec{
			{Name: "id", DataType: "BIGINT", Nullable: false, AutoIncrement: true},
			{Name: "email", DataType: "VARCHAR(255)", Nullable: false},
			{Name: "created_at", DataType: "TIMESTAMP", Nullable: false},
		},
		PrimaryKey: []string{"id"},
	}
	got, err := d.RenderTable(context.Background(), spec)
	if err != nil {
		t.Fatal(err)
	}
	want := mustReadGolden(t, "postgres/table_create.sql")
	if got != want {
		t.Fatalf("RenderTable mismatch.\ngot:\n%s\nwant:\n%s", got, want)
	}
}
