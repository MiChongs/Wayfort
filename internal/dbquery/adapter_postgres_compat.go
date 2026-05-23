package dbquery

import (
	"context"
	"database/sql"

	"github.com/michongs/jumpserver-anonymous/internal/model"
)

// postgresCompatAdapter is the base struct for every PG-wire-protocol-
// compatible engine. Each Chinese-DB child (KingbaseES / Vastbase /
// Highgo / openGauss / GaussDB / GBase 8s) embeds it, overrides
// Protocol + Capabilities + Driver with vendor specifics, and inherits
// the PG dialect + introspection via the FamilyPostgres tag.
//
// All these engines speak the PostgreSQL wire protocol — jackc/pgx
// connects to them unchanged. We mint engine-specific defaults for the
// fallback database name (KingbaseES uses "TEST", openGauss uses
// "postgres", etc.) so the connection succeeds out of the box.
type postgresCompatAdapter struct {
	protocol    model.NodeProtocol
	vendorLabel string
	defaultDB   string
	runtime     map[string]string
	caps        Capabilities
}

func (a postgresCompatAdapter) Protocol() model.NodeProtocol { return a.protocol }
func (a postgresCompatAdapter) Family() Family               { return FamilyPostgres }
func (a postgresCompatAdapter) Dialect() Dialect             { return postgresDialect{} }

func (a postgresCompatAdapter) Capabilities() Capabilities {
	caps := a.caps
	caps.DatabaseScope = DatabaseScopeCatalog
	if caps.VendorLabel == "" {
		caps.VendorLabel = a.vendorLabel
	}
	// Annotate the label with the native-binding tag when a vendor
	// driver is registered. Operators see e.g. "openGauss · 官方驱动"
	// in the DB Studio header instead of the unadorned "openGauss".
	if extra := LookupNativeLabel(a.protocol); extra != "" {
		caps.VendorLabel = caps.VendorLabel + " · " + extra
	}
	return caps
}

// Driver — registry-first lookup. Native vendor bindings (KingbaseES'
// KCI, openGauss-connector-go-pq with SM3/SHA-256 auth, etc.) win;
// otherwise we fall back to the family-canonical pgx wire driver
// which speaks vanilla PG protocol — that's enough for normal queries
// against any v3-protocol-conformant fork, but won't satisfy bespoke
// auth modes.
func (a postgresCompatAdapter) Driver() Driver {
	if d, ok := LookupNativeDriver(a.protocol); ok {
		return d
	}
	return postgresCompatDriver{defaultDB: a.defaultDB, runtime: a.runtime}
}

type postgresCompatDriver struct {
	defaultDB string
	runtime   map[string]string
}

func (postgresCompatDriver) DriverName() string { return "pgx" }
func (d postgresCompatDriver) Open(_ context.Context, params ConnectionParams, dial DialFunc) (*sql.DB, func(), error) {
	defaultDB := d.defaultDB
	if defaultDB == "" {
		defaultDB = "postgres"
	}
	// Merge per-call extras over engine defaults so operators can
	// override search_path, application_name, etc. via proto_options.
	merged := map[string]string{}
	for k, v := range d.runtime {
		merged[k] = v
	}
	for k, v := range params.Extra {
		merged[k] = v
	}
	return openWithPGXDriver(params, dial, defaultDB, merged)
}

// ----- registered children --------------------------------------------------

func stdPostgresCaps() Capabilities {
	return postgresAdapter{}.Capabilities()
}

func init() {
	// KingbaseES — 人大金仓. PG-12-ish fork, supports all major features.
	{
		caps := stdPostgresCaps()
		caps.VendorLabel = "KingbaseES"
		register(postgresCompatAdapter{
			protocol:    model.NodeProtoKingbase,
			vendorLabel: "KingbaseES",
			defaultDB:   "TEST",
			caps:        caps,
		})
	}
	// Vastbase — 海量数据. PG-12 / PG-14 fork.
	{
		caps := stdPostgresCaps()
		caps.VendorLabel = "Vastbase"
		register(postgresCompatAdapter{
			protocol:    model.NodeProtoVastbase,
			vendorLabel: "Vastbase",
			defaultDB:   "postgres",
			caps:        caps,
		})
	}
	// HighgoDB — 瀚高数据库.
	{
		caps := stdPostgresCaps()
		caps.VendorLabel = "HighgoDB"
		register(postgresCompatAdapter{
			protocol:    model.NodeProtoHighgo,
			vendorLabel: "HighgoDB",
			defaultDB:   "highgo",
			caps:        caps,
		})
	}
	// openGauss — 华为开源版.
	{
		caps := stdPostgresCaps()
		caps.VendorLabel = "openGauss"
		// openGauss exposes pg_stat_activity; KILL goes via
		// pg_terminate_backend like vanilla PG.
		register(postgresCompatAdapter{
			protocol:    model.NodeProtoOpenGauss,
			vendorLabel: "openGauss",
			defaultDB:   "postgres",
			caps:        caps,
		})
	}
	// GaussDB — 华为商业版 (PG-兼容). Same surface as openGauss for our
	// purposes; differs in HA / distribution under the hood.
	{
		caps := stdPostgresCaps()
		caps.VendorLabel = "GaussDB"
		register(postgresCompatAdapter{
			protocol:    model.NodeProtoGaussDB,
			vendorLabel: "GaussDB",
			defaultDB:   "postgres",
			caps:        caps,
		})
	}
	// GBase 8s — 南大通用 PG-flavoured TP engine (8a is MySQL-flavoured).
	{
		caps := stdPostgresCaps()
		caps.VendorLabel = "GBase 8s"
		register(postgresCompatAdapter{
			protocol:    model.NodeProtoGBase8s,
			vendorLabel: "GBase 8s",
			defaultDB:   "postgres",
			caps:        caps,
		})
	}
}
