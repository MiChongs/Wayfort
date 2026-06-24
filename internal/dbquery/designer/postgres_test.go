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

func TestPostgresRenderView(t *testing.T) {
	d := NewPostgres()
	got, err := d.RenderView(context.Background(), ViewSpec{
		Schema:     "public",
		Name:       "active_users",
		Definition: "SELECT id, email FROM \"users\" WHERE last_login_at > NOW() - INTERVAL '30 days'",
	})
	if err != nil {
		t.Fatal(err)
	}
	if got != mustReadGolden(t, "postgres/view_create.sql") {
		t.Fatalf("RenderView mismatch.\ngot:\n%s", got)
	}
}

func TestPostgresRenderFunction(t *testing.T) {
	d := NewPostgres()
	got, err := d.RenderFunction(context.Background(), FunctionSpec{
		Schema:     "public",
		Name:       "uuid_v7",
		ReturnType: "VARCHAR(36)",
		Body:       "BEGIN\n  RETURN replace(uuid_generate_v4()::text, '-', '');\nEND",
	})
	if err != nil {
		t.Fatal(err)
	}
	if got != mustReadGolden(t, "postgres/function_create.sql") {
		t.Fatalf("RenderFunction mismatch.\ngot:\n%s", got)
	}
}

func TestPostgresRenderProcedure(t *testing.T) {
	d := NewPostgres()
	got, err := d.RenderProcedure(context.Background(), ProcedureSpec{
		Schema: "public",
		Name:   "archive_user",
		Args:   []ArgSpec{{Name: "p_user_id", DataType: "BIGINT", Mode: "IN"}},
		Body:   "UPDATE users SET archived = true WHERE id = p_user_id",
	})
	if err != nil {
		t.Fatal(err)
	}
	if got != mustReadGolden(t, "postgres/procedure_create.sql") {
		t.Fatalf("RenderProcedure mismatch.\ngot:\n%s", got)
	}
}

func TestPostgresRenderTrigger(t *testing.T) {
	d := NewPostgres()
	got, err := d.RenderTrigger(context.Background(), TriggerSpec{
		Schema:  "public",
		Name:    "tr_users_audit",
		Table:   "users",
		Timing:  "BEFORE",
		Events:  []string{"INSERT", "UPDATE"},
		ForEach: "ROW",
		Body:    "users_audit_func()",
	})
	if err != nil {
		t.Fatal(err)
	}
	if got != mustReadGolden(t, "postgres/trigger_create.sql") {
		t.Fatalf("RenderTrigger mismatch.\ngot:\n%s", got)
	}
}

// PostgreSQL has no native events; the designer returns a deterministic error
// directing the caller to the pg_cron extension or an external scheduler.
func TestPostgresRenderEvent_Unsupported(t *testing.T) {
	d := NewPostgres()
	_, err := d.RenderEvent(context.Background(), EventSpec{Schema: "public", Name: "ev"})
	wantErr := "designer: PostgreSQL has no native events; use the pg_cron extension or an external scheduler"
	if err == nil || err.Error() != wantErr {
		t.Fatalf("expected error %q, got %v", wantErr, err)
	}
}

func TestPostgresRenderIndex(t *testing.T) {
	d := NewPostgres()
	got, err := d.RenderIndex(context.Background(), IndexSpec{
		Name:    "idx_users_fts",
		Columns: []string{"email"},
		Method:  "GIN",
		Where:   "active = true",
	})
	if err != nil {
		t.Fatal(err)
	}
	if got != mustReadGolden(t, "postgres/index_create.sql") {
		t.Fatalf("RenderIndex mismatch.\ngot:\n%s", got)
	}
}

func TestPostgresRenderSequence(t *testing.T) {
	d := NewPostgres()
	got, err := d.RenderSequence(context.Background(), SequenceSpec{
		Schema:    "public",
		Name:      "seq_user_id",
		Start:     10000,
		Increment: 1,
		Cache:     20,
		Cycle:     true,
	})
	if err != nil {
		t.Fatal(err)
	}
	if got != mustReadGolden(t, "postgres/sequence_create.sql") {
		t.Fatalf("RenderSequence mismatch.\ngot:\n%s", got)
	}
}
