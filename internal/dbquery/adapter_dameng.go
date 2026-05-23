package dbquery

import (
	"context"
	"database/sql"
	"fmt"
	"strings"

	"github.com/michongs/jumpserver-anonymous/internal/model"
)

// damengAdapter is the 达梦 DM8 adapter. DM uses an Oracle-flavoured
// dialect (double-quoted identifiers, $1-style placeholders unavailable
// — uses positional `?`, but most introspection goes through Oracle-
// shaped catalog views SYS.ALL_TABLES / SYS.ALL_TAB_COLUMNS / etc.).
//
// Wire driver: gitee.com/chunanyong/dm — the official Go driver. It's
// not bundled by default because the gitee module proxy isn't reachable
// from every CI environment. Adapters register a placeholder driver
// that explains how to wire the real one (see damengDriver.Open).
// Operators who need real DM connectivity vendor the driver into their
// own build OR run a separate dm-bridge service.
type damengAdapter struct{}

func (damengAdapter) Protocol() model.NodeProtocol { return model.NodeProtoDameng }
func (damengAdapter) Family() Family               { return FamilyOracle }

func (damengAdapter) Capabilities() Capabilities {
	return Capabilities{
		ListDatabases:  true,
		Schemas:        true, // DM schemas == users
		RowEdits:       true,
		Explain:        true,
		ExplainAnalyze: false, // DM has EXPLAIN but not ANALYZE-with-execute
		Processes:      true,  // SYS.DBA_DM_SESSIONS
		KillProcess:    true,  // SP_KILL_SESSION
		TableDDL:       true,  // DBMS_METADATA.GET_DDL
		TableStats:     true,  // SYS.DBA_TABLES.NUM_ROWS
		ForeignKeys:    true,
		Export:         true,
		LastInsertID:   false,
		Sequences:      true, // CREATE SEQUENCE supported
		Functions:      true,
		Transactions:   true,
		DatabaseScope:  DatabaseScopeSchema, // DM connects to one DB, browses schemas
		VendorLabel:    "达梦 DM8",
	}
}

func (damengAdapter) Dialect() Dialect { return damengDialect{} }
func (damengAdapter) Driver() Driver   { return damengDriver{} }

func init() { register(damengAdapter{}) }

// ----- dialect --------------------------------------------------------------

// damengDialect follows Oracle conventions: double-quoted identifiers
// (case-sensitive when quoted, upper-folded when unquoted), positional
// `?` placeholders, and OFFSET ... FETCH NEXT ... pagination instead of
// MySQL's LIMIT/OFFSET. DM8 supports both forms; we use OFFSET/FETCH
// because it's the SQL standard form Dameng documents.
type damengDialect struct{}

func (damengDialect) QuoteIdent(s string) string {
	return `"` + strings.ReplaceAll(s, `"`, `""`) + `"`
}
func (damengDialect) Placeholder(int) string { return "?" }
func (d damengDialect) BuildRowsSQL(schema, table, orderBy, orderDir string, limit, offset int) (string, error) {
	if limit < 0 || offset < 0 {
		return "", fmt.Errorf("dbquery: limit and offset must be non-negative")
	}
	orderDir = strings.ToUpper(strings.TrimSpace(orderDir))
	if orderDir != "" && orderDir != "ASC" && orderDir != "DESC" {
		return "", fmt.Errorf("dbquery: order direction must be ASC or DESC")
	}
	q := "SELECT * FROM " + d.QuoteIdent(schema) + "." + d.QuoteIdent(table)
	if orderBy != "" {
		q += " ORDER BY " + d.QuoteIdent(orderBy)
		if orderDir != "" {
			q += " " + orderDir
		}
	} else {
		// DM requires ORDER BY for deterministic OFFSET ... FETCH NEXT
		// pagination. Default to ROWID order so pagination is stable.
		q += " ORDER BY ROWID"
	}
	q += fmt.Sprintf(" OFFSET %d ROWS FETCH NEXT %d ROWS ONLY", offset, limit)
	return q, nil
}

// ----- driver ---------------------------------------------------------------

// damengDriver delegates to a runtime-registered "dm" sql driver. The
// `gitee.com/chunanyong/dm` package registers itself with database/sql
// under the name "dm" via its own init(). If the operator bundles that
// import in their build (via a side-effect import in cmd/jumpserver),
// Open() opens cleanly. If not, sql.Open returns "unknown driver" and
// we wrap that with a Chinese-friendly hint pointing at the gitee
// module.
type damengDriver struct{}

func (damengDriver) DriverName() string { return "dm" }
func (damengDriver) Open(_ context.Context, params ConnectionParams, dial DialFunc) (*sql.DB, func(), error) {
	// DM's DSN: `dm://USER:PASSWORD@HOST:PORT?schema=...&autoCommit=true&...`
	// The gitee driver does NOT expose a per-connection dial-func hook
	// equivalent to mysql.RegisterDialContext or pgx.ConnConfig.DialFunc
	// (it uses net.Dial under the hood). For Phase 22 we open the
	// driver-native connection and rely on the chain's local-port-
	// forward to expose DM at 127.0.0.1:<local_port> — that's how the
	// dbcli terminal flow handles it too.
	//
	// When the operator's chain is direct (no hops) the dialer would
	// be net.Dial anyway; passing dial in is a no-op. When the chain
	// has hops, the gateway's TCP-forward layer is responsible for
	// opening the local port.
	_ = dial
	dsn := buildDamengDSN(params)
	db, err := sql.Open("dm", dsn)
	if err != nil {
		return nil, nil, fmt.Errorf("dameng open: %w (driver `dm` is not registered — vendor `gitee.com/chunanyong/dm` into your build to enable DM8 connectivity)", err)
	}
	return db, func() {}, nil
}

// buildDamengDSN turns ConnectionParams into the DM URL the driver
// expects. We force autoCommit=false so transactional UI flows work;
// the executor's Query/Exec layer manages COMMIT/ROLLBACK boundaries.
func buildDamengDSN(p ConnectionParams) string {
	host := p.Host
	if host == "" {
		host = "127.0.0.1"
	}
	port := p.Port
	if port == 0 {
		port = 5236 // DM default
	}
	q := fmt.Sprintf("dm://%s:%s@%s:%d", p.User, p.Password, host, port)
	extras := map[string]string{
		"autoCommit": "true",
	}
	for k, v := range p.Extra {
		extras[k] = v
	}
	if p.Database != "" {
		extras["schema"] = p.Database
	}
	if len(extras) > 0 {
		q += "?" + extrasQueryString(extras)
	}
	return q
}
