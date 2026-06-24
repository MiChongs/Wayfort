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

func TestMySQLRenderView(t *testing.T) {
	d := NewMySQL()
	got, err := d.RenderView(context.Background(), ViewSpec{
		Schema:     "public",
		Name:       "active_users",
		Definition: "SELECT id, email FROM `users` WHERE last_login_at > NOW() - INTERVAL 30 DAY",
	})
	if err != nil {
		t.Fatal(err)
	}
	if got != mustReadGolden(t, "mysql/view_create.sql") {
		t.Fatalf("RenderView mismatch.\ngot:\n%s", got)
	}
}

func TestMySQLRenderFunction(t *testing.T) {
	d := NewMySQL()
	got, err := d.RenderFunction(context.Background(), FunctionSpec{
		Schema:     "public",
		Name:       "uuid_v7",
		ReturnType: "VARCHAR(36)",
		Body:       "RETURN REPLACE(UUID(), '-', '');",
	})
	if err != nil {
		t.Fatal(err)
	}
	if got != mustReadGolden(t, "mysql/function_create.sql") {
		t.Fatalf("RenderFunction mismatch.\ngot:\n%s", got)
	}
}

func TestMySQLRenderProcedure(t *testing.T) {
	d := NewMySQL()
	got, err := d.RenderProcedure(context.Background(), ProcedureSpec{
		Schema: "public",
		Name:   "archive_user",
		Args:   []ArgSpec{{Name: "p_user_id", DataType: "BIGINT", Mode: "IN"}},
		Body:   "UPDATE users SET archived = 1 WHERE id = p_user_id",
	})
	if err != nil {
		t.Fatal(err)
	}
	if got != mustReadGolden(t, "mysql/procedure_create.sql") {
		t.Fatalf("RenderProcedure mismatch.\ngot:\n%s", got)
	}
}

func TestMySQLRenderTrigger(t *testing.T) {
	d := NewMySQL()
	got, err := d.RenderTrigger(context.Background(), TriggerSpec{
		Schema: "public",
		Name:   "tr_users_audit",
		Table:  "users",
		Timing: "BEFORE",
		Events: []string{"INSERT", "UPDATE"},
		Body:   "SET NEW.updated_at = NOW()",
	})
	if err != nil {
		t.Fatal(err)
	}
	if got != mustReadGolden(t, "mysql/trigger_create.sql") {
		t.Fatalf("RenderTrigger mismatch.\ngot:\n%s", got)
	}
}

func TestMySQLRenderEvent(t *testing.T) {
	d := NewMySQL()
	got, err := d.RenderEvent(context.Background(), EventSpec{
		Schema:     "public",
		Name:       "ev_nightly_archive",
		Schedule:   "EVERY 1 DAY STARTS CURRENT_TIMESTAMP",
		OnComplete: "PRESERVE",
		Body:       "CALL archive_old_sessions()",
	})
	if err != nil {
		t.Fatal(err)
	}
	if got != mustReadGolden(t, "mysql/event_create.sql") {
		t.Fatalf("RenderEvent mismatch.\ngot:\n%s", got)
	}
}

func TestMySQLRenderIndex(t *testing.T) {
	d := NewMySQL()
	got, err := d.RenderIndex(context.Background(), IndexSpec{
		Name:    "idx_users_email",
		Columns: []string{"email"},
		Unique:  true,
		Method:  "BTREE",
	})
	if err != nil {
		t.Fatal(err)
	}
	if got != mustReadGolden(t, "mysql/index_create.sql") {
		t.Fatalf("RenderIndex mismatch.\ngot:\n%s", got)
	}
}

// MySQL has no SEQUENCE object; the designer returns a deterministic error
// directing the caller to an AUTO_INCREMENT column. No golden file.
func TestMySQLRenderSequence_Unsupported(t *testing.T) {
	d := NewMySQL()
	_, err := d.RenderSequence(context.Background(), SequenceSpec{Schema: "public", Name: "seq_user_id"})
	wantErr := "designer: MySQL has no SEQUENCE object; use an AUTO_INCREMENT column instead"
	if err == nil || err.Error() != wantErr {
		t.Fatalf("expected error %q, got %v", wantErr, err)
	}
}
