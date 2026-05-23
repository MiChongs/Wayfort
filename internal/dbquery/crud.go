package dbquery

import (
	"context"
	"errors"
	"fmt"
	"strings"
	"time"

	"github.com/michongs/jumpserver-anonymous/internal/model"
)

// RowKey identifies one row in a table by its primary-key column
// values. Used by Update / Delete so the caller doesn't have to embed
// raw SQL identifiers.
type RowKey struct {
	Columns []string `json:"columns"`
	Values  []any    `json:"values"`
}

// RowEdit is the payload of UpdateRow. SetColumns + SetValues are the
// new values; the column list and value list must be the same length
// and ordered the same way.
type RowEdit struct {
	SetColumns []string `json:"set_columns"`
	SetValues  []any    `json:"set_values"`
}

// UpdateRow executes UPDATE ... WHERE pk_col1=? AND pk_col2=? ...
// Returns the number of rows actually affected (should be 0 or 1 for
// a PK-keyed update; 0 typically means a concurrent delete + the UI
// has to refresh).
func (s *Service) UpdateRow(ctx context.Context, nodeID, userID uint64,
	database, schema, table string, key RowKey, edit RowEdit) (*ExecResult, error) {
	if len(edit.SetColumns) == 0 {
		return nil, errors.New("dbquery: update has no columns")
	}
	if len(edit.SetColumns) != len(edit.SetValues) {
		return nil, errors.New("dbquery: set columns / values length mismatch")
	}
	if len(key.Columns) == 0 || len(key.Columns) != len(key.Values) {
		return nil, errors.New("dbquery: row key columns / values mismatch")
	}
	pl, err := s.getOrOpen(ctx, nodeID, userID, database)
	if err != nil {
		return nil, err
	}
	adapter, err := s.adapterForPool(pl)
	if err != nil {
		return nil, err
	}
	q, err := buildUpdateSQL(adapter.Dialect(), schema, table, edit.SetColumns, key.Columns)
	if err != nil {
		return nil, err
	}
	args := append([]any{}, edit.SetValues...)
	args = append(args, key.Values...)
	ctx, cancel := context.WithTimeout(ctx, s.queryTimeout)
	defer cancel()
	started := time.Now()
	res, err := pl.db.ExecContext(ctx, q, args...)
	if err != nil {
		return nil, fmt.Errorf("dbquery update: %w", err)
	}
	out := &ExecResult{Elapsed: time.Since(started)}
	out.Affected, _ = res.RowsAffected()
	return out, nil
}

// InsertRow executes INSERT (cols) VALUES (?, ?, ...). Returns
// LastInsertID for MySQL, 0 for Postgres (use RETURNING in a Query
// instead if you need the new key on PG).
func (s *Service) InsertRow(ctx context.Context, nodeID, userID uint64,
	database, schema, table string, cols []string, vals []any) (*ExecResult, error) {
	if len(cols) == 0 {
		return nil, errors.New("dbquery: insert has no columns")
	}
	if len(cols) != len(vals) {
		return nil, errors.New("dbquery: insert columns / values length mismatch")
	}
	pl, err := s.getOrOpen(ctx, nodeID, userID, database)
	if err != nil {
		return nil, err
	}
	adapter, err := s.adapterForPool(pl)
	if err != nil {
		return nil, err
	}
	q, err := buildInsertSQL(adapter.Dialect(), schema, table, cols)
	if err != nil {
		return nil, err
	}
	ctx, cancel := context.WithTimeout(ctx, s.queryTimeout)
	defer cancel()
	started := time.Now()
	res, err := pl.db.ExecContext(ctx, q, vals...)
	if err != nil {
		return nil, fmt.Errorf("dbquery insert: %w", err)
	}
	out := &ExecResult{Elapsed: time.Since(started)}
	out.Affected, _ = res.RowsAffected()
	if adapter.Capabilities().LastInsertID {
		out.LastInsertID, _ = res.LastInsertId()
	}
	return out, nil
}

// DeleteRow executes DELETE WHERE pk_col1=? AND ...
func (s *Service) DeleteRow(ctx context.Context, nodeID, userID uint64,
	database, schema, table string, key RowKey) (*ExecResult, error) {
	if len(key.Columns) == 0 || len(key.Columns) != len(key.Values) {
		return nil, errors.New("dbquery: row key columns / values mismatch")
	}
	pl, err := s.getOrOpen(ctx, nodeID, userID, database)
	if err != nil {
		return nil, err
	}
	adapter, err := s.adapterForPool(pl)
	if err != nil {
		return nil, err
	}
	q, err := buildDeleteSQL(adapter.Dialect(), schema, table, key.Columns)
	if err != nil {
		return nil, err
	}
	ctx, cancel := context.WithTimeout(ctx, s.queryTimeout)
	defer cancel()
	started := time.Now()
	res, err := pl.db.ExecContext(ctx, q, key.Values...)
	if err != nil {
		return nil, fmt.Errorf("dbquery delete: %w", err)
	}
	out := &ExecResult{Elapsed: time.Since(started)}
	out.Affected, _ = res.RowsAffected()
	return out, nil
}

// Explain runs EXPLAIN against the statement. analyze=true switches to
// EXPLAIN ANALYZE (PG) / EXPLAIN ANALYZE FORMAT=JSON (MySQL 8.0.18+).
// Returns the raw text result; the UI is responsible for rendering.
//
// Refuses on statements that aren't read-only — calling EXPLAIN ANALYZE
// on a DELETE will actually run the delete on PG. The strict gate
// mirrors api.isReadOnlySQL.
func (s *Service) Explain(ctx context.Context, nodeID, userID uint64,
	database, statement string, analyze bool) (*QueryResult, error) {
	pl, err := s.getOrOpen(ctx, nodeID, userID, database)
	if err != nil {
		return nil, err
	}
	var q string
	switch pl.family() {
	case FamilyPostgres:
		if analyze {
			q = "EXPLAIN (ANALYZE, BUFFERS, VERBOSE) " + statement
		} else {
			q = "EXPLAIN " + statement
		}
	case FamilyMySQL:
		if analyze {
			q = "EXPLAIN ANALYZE FORMAT=TREE " + statement
		} else {
			q = "EXPLAIN FORMAT=TREE " + statement
		}
	default:
		return nil, fmt.Errorf("dbquery explain: protocol %q not supported", pl.protocol)
	}
	return s.Query(ctx, nodeID, userID, database, q, nil, 10_000)
}

// ----- SQL builders -----

func buildUpdateSQL(d Dialect, schema, table string, setCols, keyCols []string) (string, error) {
	setParts := make([]string, len(setCols))
	args := 1
	for i, c := range setCols {
		setParts[i] = d.QuoteIdent(c) + " = " + d.Placeholder(args)
		args++
	}
	whereParts := make([]string, len(keyCols))
	for i, c := range keyCols {
		whereParts[i] = d.QuoteIdent(c) + " = " + d.Placeholder(args)
		args++
	}
	return fmt.Sprintf("UPDATE %s.%s SET %s WHERE %s",
		d.QuoteIdent(schema), d.QuoteIdent(table),
		strings.Join(setParts, ", "),
		strings.Join(whereParts, " AND ")), nil
}

func buildInsertSQL(d Dialect, schema, table string, cols []string) (string, error) {
	colNames := make([]string, len(cols))
	holders := make([]string, len(cols))
	for i, c := range cols {
		colNames[i] = d.QuoteIdent(c)
		holders[i] = d.Placeholder(i + 1)
	}
	return fmt.Sprintf("INSERT INTO %s.%s (%s) VALUES (%s)",
		d.QuoteIdent(schema), d.QuoteIdent(table),
		strings.Join(colNames, ", "),
		strings.Join(holders, ", ")), nil
}

func buildDeleteSQL(d Dialect, schema, table string, keyCols []string) (string, error) {
	whereParts := make([]string, len(keyCols))
	for i, c := range keyCols {
		whereParts[i] = d.QuoteIdent(c) + " = " + d.Placeholder(i+1)
	}
	return fmt.Sprintf("DELETE FROM %s.%s WHERE %s",
		d.QuoteIdent(schema), d.QuoteIdent(table),
		strings.Join(whereParts, " AND ")), nil
}

// quoteIdent returns the protocol-correct identifier quoter.
//
//	postgres → "ident" (ANSI double-quote, doubled inside)
//	mysql    → `ident` (backtick, doubled inside)
func quoteIdent(p model.NodeProtocol) func(string) string {
	switch p {
	case FamilyMySQL:
		return func(s string) string {
			return "`" + strings.ReplaceAll(s, "`", "``") + "`"
		}
	default:
		return func(s string) string {
			return `"` + strings.ReplaceAll(s, `"`, `""`) + `"`
		}
	}
}

// placeholder returns the per-driver parameter placeholder for the
// given 1-based position. pgx/pq want $1 / $2; go-sql-driver wants ?
// regardless of position.
func placeholder(p model.NodeProtocol, n int) string {
	switch p {
	case FamilyPostgres:
		return fmt.Sprintf("$%d", n)
	default:
		return "?"
	}
}
