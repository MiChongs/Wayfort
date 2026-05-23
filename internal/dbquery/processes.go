package dbquery

import (
	"context"
	"database/sql"
	"fmt"
	"strings"

)

// ProcessInfo describes one server-side session / running query. Fields
// are intentionally a superset of both engines; entries are empty when
// the engine doesn't expose them.
type ProcessInfo struct {
	PID         int64  `json:"pid"`
	Username    string `json:"username"`
	ClientAddr  string `json:"client_addr,omitempty"`
	Database    string `json:"database,omitempty"`
	State       string `json:"state,omitempty"`
	WaitEvent   string `json:"wait_event,omitempty"`
	Application string `json:"application,omitempty"`
	// QueryStart is RFC3339 — string for transport friendliness.
	QueryStart string `json:"query_start,omitempty"`
	// Elapsed is seconds since the current statement started.
	ElapsedSec float64 `json:"elapsed_sec,omitempty"`
	Query       string  `json:"query,omitempty"`
}

// ListProcesses returns all currently-running server-side queries on
// the connected database cluster. PG: pg_stat_activity. MySQL:
// information_schema.PROCESSLIST. Permissions on the underlying view
// determine what the calling DB user can see; an unprivileged role may
// only see its own sessions.
func (s *Service) ListProcesses(ctx context.Context, nodeID, userID uint64, database string) ([]ProcessInfo, error) {
	pl, err := s.getOrOpen(ctx, nodeID, userID, database)
	if err != nil {
		return nil, err
	}
	switch pl.family() {
	case FamilyPostgres:
		return listPostgresProcesses(ctx, pl)
	case FamilyMySQL:
		return listMysqlProcesses(ctx, pl)
	case FamilyOracle:
		return listDamengProcesses(ctx, pl)
	}
	return nil, fmt.Errorf("dbquery: processes not implemented for %q", pl.protocol)
}

// CancelProcess asks the server to abort a running statement. PG uses
// pg_cancel_backend for graceful cancel; KILL on MySQL is the only
// path so we use it directly. Returns the engine's true/false response.
func (s *Service) CancelProcess(ctx context.Context, nodeID, userID uint64,
	database string, pid int64) (bool, error) {
	pl, err := s.getOrOpen(ctx, nodeID, userID, database)
	if err != nil {
		return false, err
	}
	switch pl.family() {
	case FamilyPostgres:
		var ok bool
		if err := pl.db.QueryRowContext(ctx, "SELECT pg_cancel_backend($1)", pid).Scan(&ok); err != nil {
			return false, err
		}
		return ok, nil
	case FamilyMySQL:
		// KILL QUERY targets the running statement only (the session
		// stays). The result is empty; an absent process gives an
		// error which we propagate so the UI can show it.
		_, err := pl.db.ExecContext(ctx, fmt.Sprintf("KILL QUERY %d", pid))
		if err != nil {
			return false, err
		}
		return true, nil
	case FamilyOracle:
		return cancelDamengProcess(ctx, pl, pid)
	}
	return false, fmt.Errorf("dbquery: cancel not implemented for %q", pl.protocol)
}

func listPostgresProcesses(ctx context.Context, pl *pool) ([]ProcessInfo, error) {
	rows, err := pl.db.QueryContext(ctx, `
		SELECT
		  pid,
		  COALESCE(usename, ''),
		  COALESCE(client_addr::text, ''),
		  COALESCE(datname, ''),
		  COALESCE(state, ''),
		  COALESCE(wait_event_type || ':' || wait_event, ''),
		  COALESCE(application_name, ''),
		  COALESCE(to_char(query_start, 'YYYY-MM-DD"T"HH24:MI:SS"Z"'), ''),
		  COALESCE(EXTRACT(EPOCH FROM (now() - query_start))::float8, 0),
		  COALESCE(query, '')
		FROM pg_stat_activity
		WHERE pid <> pg_backend_pid()
		ORDER BY query_start DESC NULLS LAST`)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := []ProcessInfo{}
	for rows.Next() {
		var p ProcessInfo
		if err := rows.Scan(&p.PID, &p.Username, &p.ClientAddr, &p.Database, &p.State,
			&p.WaitEvent, &p.Application, &p.QueryStart, &p.ElapsedSec, &p.Query); err != nil {
			return nil, err
		}
		out = append(out, p)
	}
	return out, rows.Err()
}

func listMysqlProcesses(ctx context.Context, pl *pool) ([]ProcessInfo, error) {
	rows, err := pl.db.QueryContext(ctx, `
		SELECT
		  ID, COALESCE(USER, ''), COALESCE(HOST, ''), COALESCE(DB, ''),
		  COALESCE(COMMAND, ''), COALESCE(STATE, ''),
		  COALESCE(TIME, 0), COALESCE(INFO, '')
		FROM information_schema.PROCESSLIST
		WHERE ID <> CONNECTION_ID()
		ORDER BY TIME DESC`)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := []ProcessInfo{}
	for rows.Next() {
		var p ProcessInfo
		var command string
		var elapsedSec int64
		if err := rows.Scan(&p.PID, &p.Username, &p.ClientAddr, &p.Database,
			&command, &p.State, &elapsedSec, &p.Query); err != nil {
			return nil, err
		}
		// MySQL doesn't expose query_start directly; report TIME as
		// elapsed seconds.
		p.ElapsedSec = float64(elapsedSec)
		p.WaitEvent = command
		out = append(out, p)
	}
	return out, rows.Err()
}

// streamExport runs SELECT * with the supplied limit (or no limit when
// limit<=0) and feeds rows to the visitor. The visitor returns an
// error to abort. Used by the export endpoint to write a CSV / JSONL /
// SQL stream straight to the HTTP response body.
//
// We deliberately don't reuse the Query path: that one materialises
// every row in memory before returning. Streaming export uses sql.Rows
// directly so a 10 GB table doesn't OOM the gateway.
func (s *Service) streamExport(ctx context.Context, nodeID, userID uint64,
	database, schema, table string, limit int,
	visit func(columns []ColumnMeta, row []any) error) error {
	pl, err := s.getOrOpen(ctx, nodeID, userID, database)
	if err != nil {
		return err
	}
	q := quoteIdent(pl.family())
	sqlText := fmt.Sprintf("SELECT * FROM %s.%s", q(schema), q(table))
	if limit > 0 {
		sqlText += fmt.Sprintf(" LIMIT %d", limit)
	}
	// Don't bind s.queryTimeout — export of a big table legitimately
	// runs for minutes. The client cancels via context (gin propagates
	// Request.Context cancellation when the browser closes the tab).
	rows, err := pl.db.QueryContext(ctx, sqlText)
	if err != nil {
		return err
	}
	defer rows.Close()
	colTypes, err := rows.ColumnTypes()
	if err != nil {
		return err
	}
	cols := make([]ColumnMeta, len(colTypes))
	for i, ct := range colTypes {
		cm := ColumnMeta{Name: ct.Name(), Type: strings.ToUpper(ct.DatabaseTypeName())}
		if nullable, ok := ct.Nullable(); ok {
			cm.Nullable = &nullable
		}
		cols[i] = cm
	}
	scanBuf := make([]any, len(cols))
	scanPtrs := make([]any, len(cols))
	for i := range scanBuf {
		scanPtrs[i] = &scanBuf[i]
	}
	for rows.Next() {
		if err := rows.Scan(scanPtrs...); err != nil {
			return err
		}
		row := make([]any, len(scanBuf))
		for i, v := range scanBuf {
			row[i] = normalise(v)
		}
		if err := visit(cols, row); err != nil {
			return err
		}
	}
	return rows.Err()
}

// StreamExport is the public entry point used by the REST handler. The
// visitor closure is called once per row; the column slice is the
// same instance across calls so the writer doesn't allocate per row.
func (s *Service) StreamExport(ctx context.Context, nodeID, userID uint64,
	database, schema, table string, limit int,
	visit func(columns []ColumnMeta, row []any) error) error {
	return s.streamExport(ctx, nodeID, userID, database, schema, table, limit, visit)
}

// Ensure sql is imported; used by other files in the package only.
var _ = sql.ErrNoRows
