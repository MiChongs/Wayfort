package designer

import (
	"context"
	"testing"
)

func TestDamengRenderTable_Create(t *testing.T) {
	d := NewDameng()
	spec := TableSpec{
		Schema: "APP_USER", Name: "users",
		Columns: []ColumnSpec{
			{Name: "id", DataType: "BIGINT", Nullable: false},
			{Name: "email", DataType: "VARCHAR(255)", Nullable: false},
			{Name: "created_at", DataType: "TIMESTAMP", Nullable: false},
		},
		PrimaryKey: []string{"id"},
	}
	got, err := d.RenderTable(context.Background(), spec)
	if err != nil {
		t.Fatal(err)
	}
	want := mustReadGolden(t, "dameng/table_create.sql")
	if got != want {
		t.Fatalf("RenderTable mismatch.\ngot:\n%s\nwant:\n%s", got, want)
	}
}
