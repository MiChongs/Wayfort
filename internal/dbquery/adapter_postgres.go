package dbquery

import (
	"context"
	"database/sql"
	"fmt"
	"strings"

	"github.com/michongs/wayfort/internal/dbquery/completion"
	"github.com/michongs/wayfort/internal/dbquery/designer"
	"github.com/michongs/wayfort/internal/dbquery/modeler"
	"github.com/michongs/wayfort/internal/dbquery/planner"
	"github.com/michongs/wayfort/internal/dbquery/profiler"
	"github.com/michongs/wayfort/internal/model"
)

// postgresAdapter is the canonical Postgres adapter. PG-wire-protocol-
// compatible engines (KingbaseES / Vastbase / Highgo / openGauss /
// GaussDB / GBase 8s) derive from it via postgresCompatAdapter.
type postgresAdapter struct{}

func (postgresAdapter) Protocol() model.NodeProtocol { return model.NodeProtoPostgres }
func (postgresAdapter) Family() Family               { return FamilyPostgres }

func (postgresAdapter) Capabilities() Capabilities {
	return Capabilities{
		ListDatabases:    true,
		Schemas:          true,
		RowEdits:         true,
		Explain:          true,
		ExplainAnalyze:   true,
		Processes:        true,
		KillProcess:      true,
		TableDDL:         true,
		TableStats:       true,
		ForeignKeys:      true,
		Export:           true,
		LastInsertID:     false, // PG: use RETURNING / sequences
		Sequences:        true,
		Functions:        true,
		Transactions:     true,
		DatabaseScope:    DatabaseScopeCatalog,
		VendorLabel:      "PostgreSQL",
		SchemaCompletion: true,
		VisualQueryPlan:  true,
		DataProfiling:    true,
	}
}

func (postgresAdapter) Dialect() Dialect { return postgresDialect{} }
func (postgresAdapter) Driver() Driver   { return postgresDriver{defaultDB: "postgres"} }

// Phase 1 baseline — each capability family is wired here as nil and lit
// up by its owning sub-project plan:
//   - Designer    → sub-project B (object designer)
//   - Planner     → sub-project A (visual execution plan)
//   - Profiler    → sub-project C (data profiling)

func (postgresAdapter) Designer() designer.Designer               { return nil }
func (postgresAdapter) Planner(db *sql.DB) planner.Planner        { return planner.NewPostgres(db) }
func (postgresAdapter) Profiler(db *sql.DB) profiler.Profiler     { return profiler.NewPostgres(db) }
func (postgresAdapter) Completion(db *sql.DB) completion.Provider { return completion.NewPostgres(db) }
func (postgresAdapter) Modeler() modeler.Modeler                  { return nil }

func init() { register(postgresAdapter{}) }

// ----- dialect --------------------------------------------------------------

type postgresDialect struct{}

func (postgresDialect) QuoteIdent(s string) string {
	return `"` + strings.ReplaceAll(s, `"`, `""`) + `"`
}
func (postgresDialect) Placeholder(n int) string { return fmt.Sprintf("$%d", n) }
func (d postgresDialect) BuildRowsSQL(schema, table, orderBy, orderDir string, limit, offset int) (string, error) {
	return buildRowsSelectSQL(d, schema, table, orderBy, orderDir, limit, offset)
}

// ----- driver ---------------------------------------------------------------

// postgresDriver opens connections through jackc/pgx/stdlib. The
// gateway's proxy-chain dialer is threaded into the per-pool
// ConnConfig (cleaner than mysql's global name registry).
type postgresDriver struct {
	defaultDB string
}

func (postgresDriver) DriverName() string { return "pgx" }
func (d postgresDriver) Open(_ context.Context, params ConnectionParams, dial DialFunc) (*sql.DB, func(), error) {
	defaultDB := d.defaultDB
	if defaultDB == "" {
		defaultDB = "postgres"
	}
	return openWithPGXDriver(params, dial, defaultDB, params.Extra)
}
