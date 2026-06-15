// Package dbquery is the structured-results DB executor. It complements
// `internal/protocols/dbcli` (which is a docker-spawned terminal client)
// by talking directly to PostgreSQL / MySQL over a `database/sql`
// connection routed through the gateway's proxy chain.
//
// The terminal flow is what an operator wants when they type ad-hoc psql
// or mysql commands; this package is what a UI uses to render schema
// trees, paginated table grids, and structured query result tables.
//
// Scope (Phase 17):
//   - mysql + postgres only. Redis and Mongo are dictionary stores and
//     get their own packages later; this one stays relational-only.
//   - One connection pool per (nodeID, userID). Pools expire after an
//     idle window so credentials don't hang around in process memory.
//   - SELECT / EXPLAIN go through Query; INSERT/UPDATE/DELETE/DDL go
//     through Exec. The split lets the REST handler gate writes behind
//     the approval `sql_exec` business type.
package dbquery

import (
	"context"
	"database/sql"
	"encoding/json"
	"errors"
	"fmt"
	"net"
	"strconv"
	"strings"
	"sync"
	"time"

	"github.com/michongs/jumpserver-anonymous/internal/asset"
	"github.com/michongs/jumpserver-anonymous/internal/model"
	"github.com/michongs/jumpserver-anonymous/internal/webssh"
	pkgcrypto "github.com/michongs/jumpserver-anonymous/pkg/crypto"
	"go.uber.org/zap"
)

// Service is the public surface used by the REST handler. One instance
// per process; concurrent calls are safe.
type Service struct {
	gw       *webssh.Gateway
	sealer   pkgcrypto.Vault
	logger   *zap.Logger
	access   accessChecker
	registry *Registry

	mu    sync.Mutex
	pools map[string]*pool

	// Tunables — sane defaults baked in; not yet wired to config because
	// the surface is small enough that no operator has expressed a need
	// to tweak.
	queryTimeout time.Duration // hard cap per query
	idleEvict    time.Duration // pool evict after no use
	maxRows      int           // row cap injected when caller didn't paginate
	maxOpenConns int           // per-pool max
}

type accessChecker interface {
	Check(ctx context.Context, userID, nodeID uint64, action string) (bool, error)
}

type pool struct {
	db          *sql.DB
	release     func() // proxy-chain release (gateway)
	driverClose func() // driver-level cleanup returned by Driver.Open (e.g. mysql dial name dereg)
	protocol    model.NodeProtocol
	adapter     Adapter
	lastUsedAt  time.Time
}

// family returns the adapter's Family tag without forcing every call
// site to type-assert through the adapter. Empty when adapter is nil
// (defensive default; shouldn't happen in production code).
func (p *pool) family() Family {
	if p == nil || p.adapter == nil {
		return ""
	}
	return p.adapter.Family()
}

// New constructs the Service. The gateway is borrowed for ResolveHops /
// BuildChain (proxy chain) + repo lookups (nodes, credentials).
func New(gw *webssh.Gateway, sealer pkgcrypto.Vault, logger *zap.Logger, access accessChecker) *Service {
	if logger == nil {
		logger = zap.NewNop()
	}
	return &Service{
		gw:           gw,
		sealer:       sealer,
		logger:       logger,
		access:       access,
		registry:     DefaultRegistry(),
		pools:        map[string]*pool{},
		queryTimeout: 60 * time.Second,
		idleEvict:    10 * time.Minute,
		maxRows:      10_000,
		maxOpenConns: 4,
	}
}

// SetMaxRows lets the handler trim the result-set cap from defaults; the
// REST layer enforces a per-request cap too. The lower wins.
func (s *Service) SetMaxRows(n int) {
	if n > 0 {
		s.maxRows = n
	}
}

// SetQueryTimeout overrides the per-query timeout (default 60s).
func (s *Service) SetQueryTimeout(d time.Duration) {
	if d > 0 {
		s.queryTimeout = d
	}
}

// RunEvictor periodically closes idle pools. Spawn from main's errgroup;
// blocks until ctx is canceled.
func (s *Service) RunEvictor(ctx context.Context) error {
	t := time.NewTicker(s.idleEvict / 2)
	defer t.Stop()
	for {
		select {
		case <-ctx.Done():
			s.closeAll()
			return ctx.Err()
		case <-t.C:
			s.evictIdle()
		}
	}
}

// QueryResult is what Query returns. Rows is a row-major slice of the
// raw column values; the caller renders. Truncated=true means the result
// hit MaxRows or a caller-supplied limit.
type QueryResult struct {
	Columns   []ColumnMeta  `json:"columns"`
	Rows      [][]any       `json:"rows"`
	Truncated bool          `json:"truncated"`
	Elapsed   time.Duration `json:"elapsed"`
	RowCount  int           `json:"row_count"`
}

// ColumnMeta describes one column of the result set. Type is the
// database-side type name as reported by the driver (e.g. "VARCHAR",
// "INT8"). The handler renders it as a chip in the column header.
type ColumnMeta struct {
	Name string `json:"name"`
	Type string `json:"type"`
	// Nullable when the driver reports nullability metadata. NULL when
	// the driver doesn't expose it.
	Nullable *bool `json:"nullable,omitempty"`
}

// ExecResult is for write statements. Affected is what RowsAffected
// reports; LastInsertID is reserved for mysql (postgres returns 0).
type ExecResult struct {
	Affected     int64         `json:"affected"`
	LastInsertID int64         `json:"last_insert_id,omitempty"`
	Elapsed      time.Duration `json:"elapsed"`
}

// Query executes a single SELECT / EXPLAIN / SHOW etc. statement and
// returns a structured result. `args` are the positional parameters.
//
// Limit handling:
//   - If `requestedMax > 0`, that's the cap. The service ALSO enforces
//     its own ceiling (s.maxRows) and applies min(requestedMax, maxRows).
//   - The cap is enforced by reading at most cap+1 rows and reporting
//     Truncated when the +1 row exists. We DON'T rewrite the SQL to
//     append LIMIT because the caller may have already paginated and a
//     duplicate LIMIT would behave inconsistently across dialects.
func (s *Service) Query(ctx context.Context, nodeID uint64, userID uint64,
	database, statement string, args []any, requestedMax int) (*QueryResult, error) {
	pl, err := s.getOrOpen(ctx, nodeID, userID, database)
	if err != nil {
		return nil, err
	}
	cap := s.maxRows
	if requestedMax > 0 && requestedMax < cap {
		cap = requestedMax
	}
	ctx, cancel := context.WithTimeout(ctx, s.queryTimeout)
	defer cancel()
	started := time.Now()
	rows, err := pl.db.QueryContext(ctx, statement, args...)
	if err != nil {
		return nil, fmt.Errorf("dbquery: %w", err)
	}
	defer rows.Close()
	colTypes, err := rows.ColumnTypes()
	if err != nil {
		return nil, fmt.Errorf("dbquery: read column types: %w", err)
	}
	cols := make([]ColumnMeta, len(colTypes))
	for i, ct := range colTypes {
		cm := ColumnMeta{Name: ct.Name(), Type: strings.ToUpper(ct.DatabaseTypeName())}
		if nullable, ok := ct.Nullable(); ok {
			cm.Nullable = &nullable
		}
		cols[i] = cm
	}

	out := &QueryResult{Columns: cols, Rows: make([][]any, 0, 64)}
	scanBuf := make([]any, len(cols))
	scanPtrs := make([]any, len(cols))
	for i := range scanBuf {
		scanPtrs[i] = &scanBuf[i]
	}
	for rows.Next() {
		if len(out.Rows) >= cap {
			out.Truncated = true
			break
		}
		if err := rows.Scan(scanPtrs...); err != nil {
			return nil, fmt.Errorf("dbquery: scan: %w", err)
		}
		// Copy + normalise. database/sql gives us []byte for unknown
		// types and TIME values vary by driver; we coerce to strings
		// for transport so the front-end gets predictable JSON.
		row := make([]any, len(scanBuf))
		for i, v := range scanBuf {
			row[i] = normalise(v)
		}
		out.Rows = append(out.Rows, row)
	}
	if err := rows.Err(); err != nil {
		return nil, fmt.Errorf("dbquery: rows iter: %w", err)
	}
	out.RowCount = len(out.Rows)
	out.Elapsed = time.Since(started)
	return out, nil
}

// Exec runs INSERT / UPDATE / DELETE / DDL. Returns affected rows.
func (s *Service) Exec(ctx context.Context, nodeID, userID uint64,
	database, statement string, args []any) (*ExecResult, error) {
	pl, err := s.getOrOpen(ctx, nodeID, userID, database)
	if err != nil {
		return nil, err
	}
	ctx, cancel := context.WithTimeout(ctx, s.queryTimeout)
	defer cancel()
	started := time.Now()
	res, err := pl.db.ExecContext(ctx, statement, args...)
	if err != nil {
		return nil, fmt.Errorf("dbquery exec: %w", err)
	}
	out := &ExecResult{Elapsed: time.Since(started)}
	out.Affected, _ = res.RowsAffected()
	adapter, err := s.adapterForPool(pl)
	if err != nil {
		return nil, err
	}
	if adapter.Capabilities().LastInsertID {
		out.LastInsertID, _ = res.LastInsertId()
	}
	return out, nil
}

// Ping checks an existing pool (or opens one) and runs a no-op probe.
// Used by the REST handler to fail-fast on connectivity / auth.
func (s *Service) Ping(ctx context.Context, nodeID, userID uint64, database string) error {
	pl, err := s.getOrOpen(ctx, nodeID, userID, database)
	if err != nil {
		return err
	}
	ctx, cancel := context.WithTimeout(ctx, 5*time.Second)
	defer cancel()
	return pl.db.PingContext(ctx)
}

// poolKey is what identifies a (node, user, database) pool. Including
// the user keeps per-user audit boundaries clean; including the database
// is critical for PostgreSQL where the database is set at connect time
// and can't be switched on an existing connection. Empty database keeps
// pre-extension callers working — they get the driver default db.
func poolKey(nodeID, userID uint64, database string) string {
	return strconv.FormatUint(nodeID, 10) + ":" + strconv.FormatUint(userID, 10) + ":" + database
}

// getOrOpen reuses a live pool or opens a new one. database="" means
// "use whatever the node's proto_options names, or the driver default".
// Non-empty database overrides per call.
func (s *Service) getOrOpen(ctx context.Context, nodeID, userID uint64, database string) (*pool, error) {
	if err := s.requireNodeAccess(ctx, userID, nodeID); err != nil {
		return nil, err
	}
	key := poolKey(nodeID, userID, database)
	s.mu.Lock()
	if pl, ok := s.pools[key]; ok {
		pl.lastUsedAt = time.Now()
		s.mu.Unlock()
		return pl, nil
	}
	s.mu.Unlock()

	// Build outside the lock — opening involves DNS + chain dial.
	pl, err := s.build(ctx, nodeID, userID, database)
	if err != nil {
		return nil, err
	}
	s.mu.Lock()
	// Double-check after acquiring — another goroutine might have raced.
	if existing, ok := s.pools[key]; ok {
		s.mu.Unlock()
		// Discard our freshly-built pool.
		_ = pl.db.Close()
		if pl.release != nil {
			pl.release()
		}
		existing.lastUsedAt = time.Now()
		return existing, nil
	}
	s.pools[key] = pl
	s.mu.Unlock()
	return pl, nil
}

func (s *Service) requireNodeAccess(ctx context.Context, userID, nodeID uint64) error {
	if s.access == nil {
		return errors.New("dbquery: asset resolver not configured")
	}
	ok, err := s.access.Check(ctx, userID, nodeID, asset.ActionConnect)
	if err != nil {
		return fmt.Errorf("dbquery: check node access: %w", err)
	}
	if !ok {
		return errors.New("dbquery: node access denied")
	}
	return nil
}

// build does the heavy lifting: load the node + credential, build the
// chain dialer, register / inject it into the driver, and Ping. The
// returned pool is ready for queries.
//
// `database` overrides the per-node proto_options.database when
// non-empty. For postgres an empty argument falls back to proto_options
// or "postgres". For mysql an empty argument falls back to "" (the
// driver treats it as "no default schema"; SHOW DATABASES / SELECT
// across schemas still works).
func (s *Service) build(ctx context.Context, nodeID, userID uint64, database string) (*pool, error) {
	node, err := s.gw.NodeRepo().FindByID(ctx, nodeID)
	if err != nil {
		return nil, fmt.Errorf("dbquery: load node: %w", err)
	}
	if node == nil {
		return nil, errors.New("dbquery: node not found")
	}
	registry := s.registry
	if registry == nil {
		registry = DefaultRegistry()
	}
	adapter, ok := registry.Get(node.EffectiveProtocol())
	if !ok {
		return nil, fmt.Errorf("dbquery: protocol %q not supported", node.EffectiveProtocol())
	}

	cred, err := s.gw.CredentialRepo().FindByID(ctx, node.CredentialID)
	if err != nil {
		return nil, fmt.Errorf("dbquery: load credential: %w", err)
	}
	if cred == nil {
		return nil, errors.New("dbquery: credential not found")
	}
	if cred.Kind != model.CredentialPassword {
		return nil, errors.New("dbquery: only password credentials supported")
	}
	pwBytes, err := s.sealer.Open(cred.Secret)
	if err != nil {
		return nil, fmt.Errorf("dbquery: decrypt credential: %w", err)
	}

	chain, _, release, err := s.gw.DialerForNode(ctx, node, fmt.Sprintf("db-node-%d", node.ID))
	if err != nil {
		return nil, fmt.Errorf("dbquery: resolve dialer: %w", err)
	}

	user := cred.Username
	if user == "" {
		user = node.Username
	}
	password := string(pwBytes)
	// Best-effort wipe.
	for i := range pwBytes {
		pwBytes[i] = 0
	}

	if database == "" {
		database = dbNameFromOptions(node.ProtoOptions, node.EffectiveProtocol())
	}

	// Phase 22 — dispatch through the adapter's Driver. Each adapter
	// owns its own DSN flavour + dialer hook; service.go no longer
	// hard-codes mysql/postgres. New engines plug in by registering an
	// Adapter in their init(); nothing here changes.
	params := ConnectionParams{
		Host:     node.Host,
		Port:     node.Port,
		User:     user,
		Password: password,
		Database: database,
		Extra:    parseProtoOptionsExtras(node.ProtoOptions),
	}
	dialFn := func(ctx context.Context, network, address string) (net.Conn, error) {
		return chain.DialContext(ctx, network, address)
	}
	db, driverClose, err := adapter.Driver().Open(ctx, params, dialFn)
	if err != nil {
		release()
		return nil, fmt.Errorf("dbquery: open %s: %w", adapter.Protocol(), err)
	}

	db.SetMaxOpenConns(s.maxOpenConns)
	db.SetMaxIdleConns(2)
	db.SetConnMaxLifetime(30 * time.Minute)

	pingCtx, cancel := context.WithTimeout(ctx, 8*time.Second)
	if err := db.PingContext(pingCtx); err != nil {
		cancel()
		_ = db.Close()
		if driverClose != nil {
			driverClose()
		}
		release()
		return nil, fmt.Errorf("dbquery: ping %s: %w", adapter.Protocol(), err)
	}
	cancel()

	return &pool{
		db:          db,
		release:     release,
		driverClose: driverClose,
		protocol:    node.EffectiveProtocol(),
		adapter:     adapter,
		lastUsedAt:  time.Now(),
	}, nil
}

// evictIdle closes pools that haven't been used inside the idle window.
func (s *Service) evictIdle() {
	cutoff := time.Now().Add(-s.idleEvict)
	s.mu.Lock()
	defer s.mu.Unlock()
	for k, pl := range s.pools {
		if pl.lastUsedAt.Before(cutoff) {
			s.logger.Info("dbquery: evicting idle pool", zap.String("key", k))
			_ = pl.db.Close()
			if pl.driverClose != nil {
				pl.driverClose()
			}
			if pl.release != nil {
				pl.release()
			}
			delete(s.pools, k)
		}
	}
}

func (s *Service) closeAll() {
	s.mu.Lock()
	defer s.mu.Unlock()
	for k, pl := range s.pools {
		_ = pl.db.Close()
		if pl.driverClose != nil {
			pl.driverClose()
		}
		if pl.release != nil {
			pl.release()
		}
		delete(s.pools, k)
	}
}

// ----- helpers --------------------------------------------------------------

// stringOr returns s if non-empty, else d.
func stringOr(s, d string) string {
	if strings.TrimSpace(s) == "" {
		return d
	}
	return s
}

// normalise turns driver-specific scan results into JSON-friendly values.
// []byte → string (UTF-8 assumed for textual columns; binary blobs come
// across as base64 once json.Marshal sees []byte, which is also fine).
// Time → RFC3339 string. Everything else passes through unchanged.
func normalise(v any) any {
	switch x := v.(type) {
	case nil:
		return nil
	case []byte:
		// MySQL driver returns TEXT/CHAR/VARCHAR as []byte by default
		// unless we set parseTime / interpolateParams. We assume UTF-8
		// here because that's what every modern deployment is.
		return string(x)
	case time.Time:
		return x.UTC().Format(time.RFC3339Nano)
	}
	return v
}

// parseProtoOptionsExtras decodes the node's proto_options JSON into a
// flat string map. Adapter drivers receive this via ConnectionParams.
// Extra so engine-specific tuning (sslmode, charset, application_name,
// search_path, tenant=oracle for OceanBase, etc.) flows through without
// each driver having to re-parse the blob. Reserved keys "database" /
// "dbname" / "schema" are dropped from the extras (they're routed via
// ConnectionParams.Database).
func parseProtoOptionsExtras(raw string) map[string]string {
	raw = strings.TrimSpace(raw)
	if raw == "" {
		return nil
	}
	var blob map[string]any
	if err := json.Unmarshal([]byte(raw), &blob); err != nil {
		return nil
	}
	if len(blob) == 0 {
		return nil
	}
	out := make(map[string]string, len(blob))
	for k, v := range blob {
		switch strings.ToLower(k) {
		case "database", "dbname", "schema", "rdp":
			// "database"/"dbname"/"schema" already handled via
			// ConnectionParams.Database. "rdp" is the desktop sub-
			// envelope — irrelevant to a DB driver.
			continue
		}
		switch x := v.(type) {
		case string:
			out[k] = x
		case bool:
			if x {
				out[k] = "true"
			} else {
				out[k] = "false"
			}
		case float64:
			// JSON numbers come back as float64; render without
			// the .0 tail when integer-valued so port numbers etc.
			// land cleanly.
			if x == float64(int64(x)) {
				out[k] = fmt.Sprintf("%d", int64(x))
			} else {
				out[k] = fmt.Sprintf("%g", x)
			}
		}
	}
	if len(out) == 0 {
		return nil
	}
	return out
}

// dbNameFromOptions reads proto_options JSON looking for "database" /
// "dbname" / "schema" fields. Returns empty string when absent so the
// driver picks its default.
func dbNameFromOptions(raw string, p model.NodeProtocol) string {
	raw = strings.TrimSpace(raw)
	if raw == "" {
		return ""
	}
	// Tiny inline parser to avoid pulling in encoding/json + a struct
	// just to read one optional field.
	for _, key := range []string{`"database"`, `"dbname"`, `"schema"`} {
		idx := strings.Index(raw, key)
		if idx < 0 {
			continue
		}
		tail := raw[idx+len(key):]
		colon := strings.Index(tail, ":")
		if colon < 0 {
			continue
		}
		tail = strings.TrimSpace(tail[colon+1:])
		if !strings.HasPrefix(tail, `"`) {
			continue
		}
		end := strings.Index(tail[1:], `"`)
		if end < 0 {
			continue
		}
		return tail[1 : 1+end]
	}
	_ = p
	return ""
}
