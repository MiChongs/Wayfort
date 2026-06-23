package dbquery

import (
	"strings"
	"testing"

	"github.com/michongs/wayfort/internal/model"
)

func TestDefaultRegistry(t *testing.T) {
	t.Parallel()
	registry := DefaultRegistry()

	mysql, ok := registry.Get(model.NodeProtoMySQL)
	if !ok {
		t.Fatalf("DefaultRegistry missing mysql adapter")
	}
	postgres, ok := registry.Get(model.NodeProtoPostgres)
	if !ok {
		t.Fatalf("DefaultRegistry missing postgres adapter")
	}
	if !mysql.Capabilities().LastInsertID {
		t.Fatalf("mysql LastInsertID capability = false, want true")
	}
	if postgres.Capabilities().LastInsertID {
		t.Fatalf("postgres LastInsertID capability = true, want false")
	}
	if !mysql.Capabilities().Export || !postgres.Capabilities().Export {
		t.Fatalf("export capability should be true for mysql and postgres")
	}
	if mysql.Capabilities().DatabaseScope == "" || postgres.Capabilities().DatabaseScope == "" {
		t.Fatalf("database scope must be non-empty")
	}
}

func TestDialectBuildRowsSQL(t *testing.T) {
	t.Parallel()
	tests := []struct {
		name       string
		dialect    Dialect
		schema     string
		wantPrefix string
		wantOrder  string
	}{
		{
			name:       "mysql",
			dialect:    mysqlDialect{},
			schema:     "app`schema",
			wantPrefix: "SELECT * FROM `app``schema`.`users`",
			wantOrder:  "ORDER BY `id` DESC",
		},
		{
			name:       "postgres",
			dialect:    postgresDialect{},
			schema:     "app\"schema",
			wantPrefix: `SELECT * FROM "app""schema"."users"`,
			wantOrder:  `ORDER BY "id" DESC`,
		},
	}
	for _, tt := range tests {
		tt := tt
		t.Run(tt.name, func(t *testing.T) {
			t.Parallel()
			got, err := tt.dialect.BuildRowsSQL(tt.schema, "users", "id", "DESC", 100, 20)
			if err != nil {
				t.Fatalf("BuildRowsSQL() error = %v", err)
			}
			if !strings.HasPrefix(got, tt.wantPrefix) {
				t.Fatalf("BuildRowsSQL() = %q, want prefix %q", got, tt.wantPrefix)
			}
			if !strings.Contains(got, tt.wantOrder) {
				t.Fatalf("BuildRowsSQL() = %q, want order %q", got, tt.wantOrder)
			}
			if !strings.HasSuffix(got, "LIMIT 100 OFFSET 20") {
				t.Fatalf("BuildRowsSQL() = %q, want LIMIT/OFFSET suffix", got)
			}
		})
	}
}

func TestDialectPlaceholders(t *testing.T) {
	t.Parallel()
	if got := (mysqlDialect{}).Placeholder(1); got != "?" {
		t.Fatalf("mysql placeholder = %q, want ?", got)
	}
	if got := (postgresDialect{}).Placeholder(1); got != "$1" {
		t.Fatalf("postgres placeholder = %q, want $1", got)
	}
}

func TestBuildRowsSQLRejectsNegativeLimitOffset(t *testing.T) {
	t.Parallel()
	if _, err := (mysqlDialect{}).BuildRowsSQL("s", "t", "", "", -1, 0); err == nil {
		t.Fatalf("BuildRowsSQL() with negative limit error = nil, want error")
	}
	if _, err := (postgresDialect{}).BuildRowsSQL("s", "t", "", "", 1, -1); err == nil {
		t.Fatalf("BuildRowsSQL() with negative offset error = nil, want error")
	}
}

func TestCapabilitiesNewFieldsZeroValue(t *testing.T) {
	var caps Capabilities
	if caps.ObjectDesigner != 0 {
		t.Fatal("ObjectDesigner default must be 0 (no kinds)")
	}
	if caps.VisualQueryPlan || caps.DataProfiling || caps.SchemaCompletion ||
		caps.ERModel || caps.PinnedResults || caps.VisualBuilder {
		t.Fatal("new bool capabilities must default false")
	}
}
