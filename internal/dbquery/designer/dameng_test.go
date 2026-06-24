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

func TestDamengRenderView(t *testing.T) {
	d := NewDameng()
	got, err := d.RenderView(context.Background(), ViewSpec{
		Schema:     "APP_USER",
		Name:       "active_users",
		Definition: "SELECT id, email FROM \"USERS\" WHERE last_login_at > SYSDATE - 30",
	})
	if err != nil {
		t.Fatal(err)
	}
	if got != mustReadGolden(t, "dameng/view_create.sql") {
		t.Fatalf("RenderView mismatch.\ngot:\n%s", got)
	}
}

func TestDamengRenderFunction(t *testing.T) {
	d := NewDameng()
	got, err := d.RenderFunction(context.Background(), FunctionSpec{
		Schema:     "APP_USER",
		Name:       "uuid_v7",
		ReturnType: "VARCHAR(36)",
		Body:       "v_uuid := REPLACE(SYS_GUID(), '-', '')",
	})
	if err != nil {
		t.Fatal(err)
	}
	if got != mustReadGolden(t, "dameng/function_create.sql") {
		t.Fatalf("RenderFunction mismatch.\ngot:\n%s", got)
	}
}

func TestDamengRenderProcedure(t *testing.T) {
	d := NewDameng()
	got, err := d.RenderProcedure(context.Background(), ProcedureSpec{
		Schema: "APP_USER",
		Name:   "archive_user",
		Args:   []ArgSpec{{Name: "p_user_id", DataType: "NUMBER(19)", Mode: "IN"}},
		Body:   "UPDATE users SET archived = 1 WHERE id = p_user_id",
	})
	if err != nil {
		t.Fatal(err)
	}
	if got != mustReadGolden(t, "dameng/procedure_create.sql") {
		t.Fatalf("RenderProcedure mismatch.\ngot:\n%s", got)
	}
}

func TestDamengRenderTrigger(t *testing.T) {
	d := NewDameng()
	got, err := d.RenderTrigger(context.Background(), TriggerSpec{
		Schema:  "APP_USER",
		Name:    "tr_users_audit",
		Table:   "users",
		Timing:  "BEFORE",
		Events:  []string{"INSERT", "UPDATE"},
		ForEach: "ROW",
		Body:    ":NEW.updated_at := SYSDATE",
	})
	if err != nil {
		t.Fatal(err)
	}
	if got != mustReadGolden(t, "dameng/trigger_create.sql") {
		t.Fatalf("RenderTrigger mismatch.\ngot:\n%s", got)
	}
}

func TestDamengRenderEvent(t *testing.T) {
	d := NewDameng()
	got, err := d.RenderEvent(context.Background(), EventSpec{
		Schema:   "APP_USER",
		Name:     "ev_nightly_archive",
		Schedule: "FREQ=DAILY; INTERVAL=1",
		Body:     "archive_old_sessions();",
	})
	if err != nil {
		t.Fatal(err)
	}
	if got != mustReadGolden(t, "dameng/event_create.sql") {
		t.Fatalf("RenderEvent mismatch.\ngot:\n%s", got)
	}
}

func TestDamengRenderIndex(t *testing.T) {
	d := NewDameng()
	got, err := d.RenderIndex(context.Background(), IndexSpec{
		Name:    "idx_users_email",
		Columns: []string{"email"},
		Unique:  true,
		Method:  "BTREE",
	})
	if err != nil {
		t.Fatal(err)
	}
	if got != mustReadGolden(t, "dameng/index_create.sql") {
		t.Fatalf("RenderIndex mismatch.\ngot:\n%s", got)
	}
}

func TestDamengRenderSequence(t *testing.T) {
	d := NewDameng()
	got, err := d.RenderSequence(context.Background(), SequenceSpec{
		Schema:    "APP_USER",
		Name:      "seq_user_id",
		Start:     10000,
		Increment: 1,
		Cache:     20,
		Cycle:     true,
	})
	if err != nil {
		t.Fatal(err)
	}
	if got != mustReadGolden(t, "dameng/sequence_create.sql") {
		t.Fatalf("RenderSequence mismatch.\ngot:\n%s", got)
	}
}
