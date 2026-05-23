package dbquery

import (
	"context"
	"database/sql"
	"fmt"
	"net"
	"net/url"
	"strconv"
	"strings"
	"time"

	mysqldrv "github.com/go-sql-driver/mysql"
	pgx "github.com/jackc/pgx/v5"
	pgxstdlib "github.com/jackc/pgx/v5/stdlib"
)

// mustNanosNow gives the current unix-nanos as int64 — used to mint
// unique driver dial-name suffixes when mysql's global registry needs
// per-pool identity.
func mustNanosNow() int64 { return time.Now().UnixNano() }

// Driver is the per-engine handle that turns connection parameters into a
// live *sql.DB. It's deliberately tiny because every engine eventually
// goes through database/sql; the divergence sits in:
//
//   - which sql driver name we open (mysql / pgx / dm / oceanbase / …)
//   - which DSN shape that driver accepts
//   - how to wire a per-connection custom dialer for the gateway's
//     proxy chain (mysql.RegisterDialContext vs pgx.ConnConfig.DialFunc
//     vs a driver-specific hook)
//
// Adapter authors implement this once; the rest of the package speaks
// to Driver through this interface and never imports a concrete driver.
type Driver interface {
	// DriverName is what sql.Open would normally accept ("mysql",
	// "pgx", "dm", "oceanbase"). When the driver needs a uniquely-
	// named instance per pool (e.g. mysql's global dial-name registry)
	// the implementation routes that internally.
	DriverName() string

	// Open turns the supplied ConnectionParams into a *sql.DB. The
	// returned closer is invoked when the pool is evicted; it should
	// undo any global state registered (mysql.DeregisterDialContext,
	// etc.). The dial function is the *net.Conn factory the driver
	// must use for every TCP connection — that's how we route through
	// the gateway's proxy chain.
	Open(ctx context.Context, params ConnectionParams, dial DialFunc) (*sql.DB, func(), error)
}

// DialFunc is the per-connection dialer the gateway hands a driver so
// every TCP handshake walks the operator-configured proxy chain.
type DialFunc func(ctx context.Context, network, addr string) (net.Conn, error)

// ConnectionParams is the engine-neutral connection descriptor. Each
// adapter projects it into its driver-specific DSN.
type ConnectionParams struct {
	Host     string
	Port     int
	User     string
	Password string
	Database string
	// Extra carries proto_options fields (sslmode, charset, schema
	// search_path, etc.) that some drivers honour and others ignore.
	Extra map[string]string
}

// Address renders host:port — convenience for adapters that build DSNs
// with the address as a single token.
func (p ConnectionParams) Address() string {
	return net.JoinHostPort(p.Host, strconv.Itoa(p.Port))
}

// ----- helpers shared across adapters --------------------------------------

// openWithMySQLDriver registers a per-pool dial context (mysql driver's
// global name registry is the way to inject a custom dialer) and opens
// the DB with the supplied DSN-without-network. ddslSchema overrides the
// per-call USE statement; empty keeps whatever the operator put in
// proto_options.
//
// Used by every MySQL-protocol-compatible engine: mysql, tidb,
// oceanbase, starrocks, doris, gbase8a, …
func openWithMySQLDriver(params ConnectionParams, dial DialFunc, dsnExtras string) (*sql.DB, func(), error) {
	dialerName := fmt.Sprintf("dbquery-mysql-%p-%d", &params, mustNanosNow())
	mysqldrv.RegisterDialContext(dialerName, func(ctx context.Context, address string) (net.Conn, error) {
		return dial(ctx, "tcp", address)
	})
	dsn := fmt.Sprintf("%s:%s@%s(%s)/%s?parseTime=true&loc=Local&charset=utf8mb4",
		params.User, params.Password, dialerName, params.Address(), params.Database)
	if dsnExtras != "" {
		dsn += "&" + dsnExtras
	}
	db, err := sql.Open("mysql", dsn)
	if err != nil {
		mysqldrv.DeregisterDialContext(dialerName)
		return nil, nil, fmt.Errorf("mysql open: %w", err)
	}
	return db, func() { mysqldrv.DeregisterDialContext(dialerName) }, nil
}

// openWithPGXDriver builds a per-pool pgx.ConnConfig (no global state)
// with the supplied dial function and opens through pgx/stdlib so the
// rest of the package speaks database/sql.
//
// Used by every Postgres-wire-compatible engine: postgres, kingbase,
// vastbase, highgo, opengauss, gaussdb, gbase8s.
//
// defaultDB lets PG-family adapters bootstrap with a known catalog
// (KingbaseES uses "TEST" capitalised, openGauss uses "postgres",
// etc.) when params.Database is empty.
func openWithPGXDriver(params ConnectionParams, dial DialFunc, defaultDB string, runtimeParams map[string]string) (*sql.DB, func(), error) {
	cfg, err := pgx.ParseConfig("")
	if err != nil {
		return nil, nil, fmt.Errorf("pgx parse: %w", err)
	}
	cfg.Host = params.Host
	cfg.Port = uint16(params.Port)
	cfg.User = params.User
	cfg.Password = params.Password
	if params.Database != "" {
		cfg.Database = params.Database
	} else {
		cfg.Database = defaultDB
	}
	cfg.TLSConfig = nil
	cfg.DialFunc = func(ctx context.Context, network, address string) (net.Conn, error) {
		return dial(ctx, network, address)
	}
	if cfg.RuntimeParams == nil {
		cfg.RuntimeParams = map[string]string{}
	}
	for k, v := range runtimeParams {
		cfg.RuntimeParams[k] = v
	}
	db := pgxstdlib.OpenDB(*cfg)
	return db, func() {}, nil
}

// extrasQueryString joins map[string]string into k=v&k=v for DSN tail.
// Keys + values are url-escaped to survive special chars; empty map →
// empty string.
func extrasQueryString(extras map[string]string) string {
	if len(extras) == 0 {
		return ""
	}
	v := url.Values{}
	for k, val := range extras {
		v.Set(k, val)
	}
	return v.Encode()
}

// notSupportedDriver is returned by adapters whose engine binding isn't
// bundled in the current build (e.g. Dameng without the gitee-hosted
// driver). The error explains how to enable.
type notSupportedDriver struct {
	protocol string
	hint     string
}

func (d notSupportedDriver) DriverName() string { return d.protocol }
func (d notSupportedDriver) Open(_ context.Context, _ ConnectionParams, _ DialFunc) (*sql.DB, func(), error) {
	return nil, nil, fmt.Errorf("dbquery: %s driver not bundled in this build (%s)", d.protocol, d.hint)
}

var _ = strings.TrimSpace // keep `strings` import alive in case adapters strip extras
