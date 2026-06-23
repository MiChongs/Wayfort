package dbquery

import (
	"context"
	"database/sql"
	"strings"

	"github.com/michongs/wayfort/internal/dbquery/completion"
	"github.com/michongs/wayfort/internal/dbquery/designer"
	"github.com/michongs/wayfort/internal/dbquery/modeler"
	"github.com/michongs/wayfort/internal/dbquery/planner"
	"github.com/michongs/wayfort/internal/dbquery/profiler"
	"github.com/michongs/wayfort/internal/model"
)

// mysqlAdapter is the canonical MySQL adapter. Every MySQL-wire-protocol-
// compatible engine (TiDB / OceanBase / StarRocks / Doris / GBase 8a)
// derives from mysqlAdapter via mysqlCompatAdapter — they keep the
// MySQL dialect + introspection and only differ in protocol id, vendor
// label and capability deltas.
type mysqlAdapter struct{}

func (mysqlAdapter) Protocol() model.NodeProtocol { return model.NodeProtoMySQL }
func (mysqlAdapter) Family() Family               { return FamilyMySQL }

func (mysqlAdapter) Capabilities() Capabilities {
	return Capabilities{
		ListDatabases:  true,
		Schemas:        true,
		RowEdits:       true,
		Explain:        true,
		ExplainAnalyze: true,
		Processes:      true,
		KillProcess:    true,
		TableDDL:       true,
		TableStats:     true,
		ForeignKeys:    true,
		Export:         true,
		LastInsertID:   true,
		Sequences:      false, // MySQL has AUTO_INCREMENT, not SEQUENCEs
		Functions:      true,
		Transactions:   true,
		DatabaseScope:  DatabaseScopeSchema,
		VendorLabel:    "MySQL",
	}
}

func (mysqlAdapter) Dialect() Dialect { return mysqlDialect{} }
func (mysqlAdapter) Driver() Driver   { return mysqlDriver{} }

// Phase 1 能力族：MySQL 适配器暂未实现，返回 nil。具体实现在 sub-project B。
func (mysqlAdapter) Designer() designer.Designer     { return nil }
func (mysqlAdapter) Planner() planner.Planner        { return nil }
func (mysqlAdapter) Profiler() profiler.Profiler     { return nil }
func (mysqlAdapter) Completion() completion.Provider { return nil }
func (mysqlAdapter) Modeler() modeler.Modeler        { return nil }

// init self-registers the canonical MySQL adapter. The MySQL-compat
// children (TiDB / OceanBase / ...) register themselves in
// adapter_mysql_compat.go.
func init() { register(mysqlAdapter{}) }

// ----- dialect --------------------------------------------------------------

type mysqlDialect struct{}

func (mysqlDialect) QuoteIdent(s string) string {
	return "`" + strings.ReplaceAll(s, "`", "``") + "`"
}
func (mysqlDialect) Placeholder(int) string { return "?" }
func (d mysqlDialect) BuildRowsSQL(schema, table, orderBy, orderDir string, limit, offset int) (string, error) {
	return buildRowsSelectSQL(d, schema, table, orderBy, orderDir, limit, offset)
}

// ----- driver ---------------------------------------------------------------

// mysqlDriver opens connections through go-sql-driver/mysql with the
// gateway's proxy-chain dialer registered via that driver's global
// dial-name registry.
type mysqlDriver struct{}

func (mysqlDriver) DriverName() string { return "mysql" }
func (mysqlDriver) Open(_ context.Context, params ConnectionParams, dial DialFunc) (*sql.DB, func(), error) {
	return openWithMySQLDriver(params, dial, extrasQueryString(params.Extra))
}
