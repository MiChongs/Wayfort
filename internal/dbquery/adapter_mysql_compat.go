package dbquery

import (
	"context"
	"database/sql"
	"strings"

	"github.com/michongs/jumpserver-anonymous/internal/model"
)

// mysqlCompatAdapter is the base struct for every MySQL-wire-protocol-
// compatible engine. Each Chinese-DB child adapter (TiDB / OceanBase /
// StarRocks / Doris / GBase 8a) embeds it, overrides Protocol() +
// Capabilities() + Driver() with the vendor-specific bits, and inherits
// the MySQL dialect + introspection by sharing the family tag.
//
// All these engines speak the MySQL wire protocol, so the go-sql-driver/
// mysql client opens connections to them unchanged. We only mint a new
// "driver name" (sql.Open key) when an engine has truly different DSN
// surface; otherwise the underlying network behaviour is identical.
type mysqlCompatAdapter struct {
	protocol     model.NodeProtocol
	vendorLabel  string
	dsnExtras    string
	caps         Capabilities
}

func (a mysqlCompatAdapter) Protocol() model.NodeProtocol { return a.protocol }
func (a mysqlCompatAdapter) Family() Family               { return FamilyMySQL }
func (a mysqlCompatAdapter) Dialect() Dialect             { return mysqlDialect{} }

func (a mysqlCompatAdapter) Capabilities() Capabilities {
	caps := a.caps
	caps.DatabaseScope = DatabaseScopeSchema
	if caps.VendorLabel == "" {
		caps.VendorLabel = a.vendorLabel
	}
	if extra := LookupNativeLabel(a.protocol); extra != "" {
		caps.VendorLabel = caps.VendorLabel + " · " + extra
	}
	return caps
}

// Driver prefers a registered native (e.g. OceanBase's obclient-go-style
// driver from an operator build) over the standard go-sql-driver/mysql
// wire client. The default works for TiDB / OceanBase MySQL-mode /
// StarRocks / Doris / GBase 8a out of the box because they all speak
// vanilla MySQL 5.7+ wire protocol; native bindings layer in vendor-
// specific affordances (tenant routing, OB Oracle-mode dialects, etc.).
func (a mysqlCompatAdapter) Driver() Driver {
	if d, ok := LookupNativeDriver(a.protocol); ok {
		return d
	}
	return mysqlCompatDriver{extras: a.dsnExtras}
}

type mysqlCompatDriver struct{ extras string }

func (mysqlCompatDriver) DriverName() string { return "mysql" }
func (d mysqlCompatDriver) Open(_ context.Context, params ConnectionParams, dial DialFunc) (*sql.DB, func(), error) {
	extras := d.extras
	if userExtras := extrasQueryString(params.Extra); userExtras != "" {
		if extras != "" {
			extras += "&" + userExtras
		} else {
			extras = userExtras
		}
	}
	return openWithMySQLDriver(params, dial, extras)
}

// ----- registered children --------------------------------------------------

// stdMysqlCaps returns the mysql-canonical capability matrix; child
// adapters mutate it.
func stdMysqlCaps() Capabilities {
	return mysqlAdapter{}.Capabilities()
}

func init() {
	// TiDB — MySQL 8.0 wire protocol; supports KILL TIDB pid.
	{
		caps := stdMysqlCaps()
		caps.VendorLabel = "TiDB"
		// TiDB's EXPLAIN ANALYZE is supported (since 4.0).
		register(mysqlCompatAdapter{
			protocol:    model.NodeProtoTiDB,
			vendorLabel: "TiDB",
			caps:        caps,
		})
	}
	// OceanBase (MySQL mode) — KILL QUERY supported under "MYSQL" tenant.
	// We don't enable Oracle mode here; that's a separate protocol id
	// when/if it lands. For tenant=foo style, operators put it in the
	// node's proto_options.
	{
		caps := stdMysqlCaps()
		caps.VendorLabel = "OceanBase (MySQL)"
		caps.Sequences = true // OB exposes SEQUENCEs even in MySQL mode
		register(mysqlCompatAdapter{
			protocol:    model.NodeProtoOceanBase,
			vendorLabel: "OceanBase (MySQL)",
			caps:        caps,
		})
	}
	// StarRocks — MySQL wire-compatible OLAP. No FK / sequences; KILL
	// works but there's no per-statement EXPLAIN ANALYZE in older
	// versions. We mark it conservatively; operators with newer SR can
	// flip capabilities at the proto_options layer in a later phase.
	{
		caps := stdMysqlCaps()
		caps.VendorLabel = "StarRocks"
		caps.ForeignKeys = false
		caps.Sequences = false
		caps.ExplainAnalyze = false
		caps.RowEdits = false // SR is OLAP; row-level UPDATE is gated
		register(mysqlCompatAdapter{
			protocol:    model.NodeProtoStarRocks,
			vendorLabel: "StarRocks",
			caps:        caps,
		})
	}
	// Apache Doris — same OLAP shape as StarRocks (they share a fork).
	{
		caps := stdMysqlCaps()
		caps.VendorLabel = "Apache Doris"
		caps.ForeignKeys = false
		caps.Sequences = false
		caps.ExplainAnalyze = false
		caps.RowEdits = false
		register(mysqlCompatAdapter{
			protocol:    model.NodeProtoDoris,
			vendorLabel: "Apache Doris",
			caps:        caps,
		})
	}
	// GBase 8a — MySQL wire-compatible columnar OLAP from 南大通用.
	{
		caps := stdMysqlCaps()
		caps.VendorLabel = "GBase 8a"
		caps.ForeignKeys = false
		caps.RowEdits = false
		register(mysqlCompatAdapter{
			protocol:    model.NodeProtoGBase8a,
			vendorLabel: "GBase 8a",
			caps:        caps,
		})
	}
}

// Keep the package's `strings` import alive when adapter authors add
// custom DSN sanitisers without immediately wiring them.
var _ = strings.ToLower
