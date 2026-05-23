package dbquery

import (
	"context"
	"database/sql"
	"fmt"
	"strings"
	"time"
)

// MultiQueryResult is the per-statement breakdown returned by QueryMulti.
// Each statement gets one entry in the same order it appeared in the
// input script. Statements that succeed have either Result (read-only,
// returned rows) or Exec (write, returned affected rows); failed
// statements have Error set and stop the run.
type MultiQueryResult struct {
	// Index is the 0-based position in the original script (after
	// stripping leading whitespace + comments).
	Index int `json:"index"`
	// Statement is the trimmed SQL text — useful for the UI when
	// rendering per-tab titles.
	Statement string `json:"statement"`
	// Kind is "query" when the statement returned rows, "exec" when it
	// returned an affected count (UPDATE/INSERT/DELETE/DDL), or "error"
	// when it failed.
	Kind string `json:"kind"`
	// One of: Result / Exec / Error (mutually exclusive).
	Result *QueryResult `json:"result,omitempty"`
	Exec   *ExecResult  `json:"exec,omitempty"`
	Error  string       `json:"error,omitempty"`
	// Elapsed is the per-statement wall time.
	Elapsed time.Duration `json:"elapsed"`
}

// QueryMulti executes a SQL script containing multiple statements
// separated by top-level semicolons. Each statement runs in its own
// QueryContext / ExecContext call; the first failure halts the run
// (later statements are not attempted — matches the psql / mysql CLI
// behaviour for non-transactional scripts).
//
// Semicolons inside string literals and dollar-quoted blocks are
// respected so a JSON / regex literal containing ';' doesn't get split.
//
// Transactional semantics: QueryMulti does NOT auto-wrap the script in
// BEGIN/COMMIT. Operators who want atomicity put BEGIN; ... COMMIT; in
// the script themselves; the driver enforces transaction state across
// the run because all statements share one *sql.DB pool connection in
// driver-managed transaction state.
func (s *Service) QueryMulti(ctx context.Context, nodeID, userID uint64,
	database, script string, maxRowsPerStmt int) ([]MultiQueryResult, error) {
	stmts := SplitStatements(script)
	if len(stmts) == 0 {
		return nil, fmt.Errorf("dbquery: no statements in script")
	}
	pl, err := s.getOrOpen(ctx, nodeID, userID, database)
	if err != nil {
		return nil, err
	}
	cap := s.maxRows
	if maxRowsPerStmt > 0 && maxRowsPerStmt < cap {
		cap = maxRowsPerStmt
	}
	out := make([]MultiQueryResult, 0, len(stmts))
	for i, q := range stmts {
		entry := MultiQueryResult{Index: i, Statement: q}
		started := time.Now()
		stmtCtx, cancel := context.WithTimeout(ctx, s.queryTimeout)

		if isReturnsRows(q) {
			rows, qerr := pl.db.QueryContext(stmtCtx, q)
			if qerr != nil {
				cancel()
				entry.Kind = "error"
				entry.Error = qerr.Error()
				entry.Elapsed = time.Since(started)
				out = append(out, entry)
				return out, nil
			}
			result, rerr := readResultRows(rows, cap)
			rows.Close()
			cancel()
			if rerr != nil {
				entry.Kind = "error"
				entry.Error = rerr.Error()
				entry.Elapsed = time.Since(started)
				out = append(out, entry)
				return out, nil
			}
			result.Elapsed = time.Since(started)
			entry.Kind = "query"
			entry.Result = result
			entry.Elapsed = result.Elapsed
			out = append(out, entry)
			continue
		}

		res, eerr := pl.db.ExecContext(stmtCtx, q)
		cancel()
		if eerr != nil {
			entry.Kind = "error"
			entry.Error = eerr.Error()
			entry.Elapsed = time.Since(started)
			out = append(out, entry)
			return out, nil
		}
		execRes := &ExecResult{Elapsed: time.Since(started)}
		execRes.Affected, _ = res.RowsAffected()
		if id, lerr := res.LastInsertId(); lerr == nil {
			execRes.LastInsertID = id
		}
		entry.Kind = "exec"
		entry.Exec = execRes
		entry.Elapsed = execRes.Elapsed
		out = append(out, entry)
	}
	return out, nil
}

// readResultRows scans a *sql.Rows into a QueryResult honouring the cap.
// Shared between QueryMulti and (potentially) a future Query refactor;
// kept separate so the cap-enforcement + normalise() pass lives in one
// place.
func readResultRows(rows *sql.Rows, cap int) (*QueryResult, error) {
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
	return out, nil
}

// SplitStatements splits a SQL script into individual statements on
// top-level semicolons. Quoted strings (single/double) and PG dollar-
// quoted blocks ($tag$ ... $tag$) are respected so embedded semicolons
// don't trigger a split. Single-line comments (-- ...) and block
// comments (/* ... */) are also respected.
//
// Exported because the frontend can preview the split client-side
// (with the JS twin) but the server-side splitter is authoritative.
func SplitStatements(script string) []string {
	out := []string{}
	var cur strings.Builder
	i := 0
	for i < len(script) {
		c := script[i]
		// Block comment
		if c == '/' && i+1 < len(script) && script[i+1] == '*' {
			end := strings.Index(script[i+2:], "*/")
			if end < 0 {
				cur.WriteString(script[i:])
				i = len(script)
				continue
			}
			cur.WriteString(script[i : i+2+end+2])
			i += 2 + end + 2
			continue
		}
		// Line comment
		if c == '-' && i+1 < len(script) && script[i+1] == '-' {
			end := strings.IndexByte(script[i:], '\n')
			if end < 0 {
				cur.WriteString(script[i:])
				i = len(script)
				continue
			}
			cur.WriteString(script[i : i+end])
			i += end
			continue
		}
		// Single/double quoted string
		if c == '\'' || c == '"' {
			quote := c
			cur.WriteByte(c)
			i++
			for i < len(script) {
				ch := script[i]
				cur.WriteByte(ch)
				if ch == '\\' && i+1 < len(script) {
					i++
					cur.WriteByte(script[i])
					i++
					continue
				}
				if ch == quote {
					if i+1 < len(script) && script[i+1] == quote {
						cur.WriteByte(quote)
						i += 2
						continue
					}
					i++
					break
				}
				i++
			}
			continue
		}
		// Dollar-quoted: $tag$ ... $tag$
		if c == '$' {
			tagEnd := strings.IndexByte(script[i+1:], '$')
			if tagEnd >= 0 && isDollarTag(script[i+1:i+1+tagEnd]) {
				tag := script[i : i+1+tagEnd+1]
				close := strings.Index(script[i+len(tag):], tag)
				if close >= 0 {
					end := i + len(tag) + close + len(tag)
					cur.WriteString(script[i:end])
					i = end
					continue
				}
			}
		}
		if c == ';' {
			stmt := strings.TrimSpace(cur.String())
			if stmt != "" {
				out = append(out, stmt)
			}
			cur.Reset()
			i++
			continue
		}
		cur.WriteByte(c)
		i++
	}
	final := strings.TrimSpace(cur.String())
	if final != "" {
		out = append(out, final)
	}
	return out
}

func isDollarTag(s string) bool {
	for i := 0; i < len(s); i++ {
		c := s[i]
		if !((c >= 'a' && c <= 'z') || (c >= 'A' && c <= 'Z') || c == '_' || (c >= '0' && c <= '9' && i > 0)) {
			return false
		}
	}
	return true
}

// isReturnsRows decides query-vs-exec by the first non-whitespace,
// non-comment keyword. CTEs and DML-with-RETURNING are treated as
// row-returning.
func isReturnsRows(sql string) bool {
	s := strings.TrimSpace(stripLeadingComments(sql))
	upper := strings.ToUpper(s)
	switch {
	case strings.HasPrefix(upper, "SELECT"),
		strings.HasPrefix(upper, "SHOW"),
		strings.HasPrefix(upper, "DESCRIBE"),
		strings.HasPrefix(upper, "DESC "),
		strings.HasPrefix(upper, "EXPLAIN"),
		strings.HasPrefix(upper, "VALUES"),
		strings.HasPrefix(upper, "TABLE "),
		strings.HasPrefix(upper, "WITH"),
		strings.HasPrefix(upper, "PRAGMA"):
		return true
	}
	if strings.Contains(upper, " RETURNING ") {
		return true
	}
	return false
}

func stripLeadingComments(s string) string {
	for {
		s = strings.TrimLeft(s, " \t\r\n")
		if strings.HasPrefix(s, "--") {
			if nl := strings.IndexByte(s, '\n'); nl >= 0 {
				s = s[nl+1:]
				continue
			}
			return ""
		}
		if strings.HasPrefix(s, "/*") {
			if end := strings.Index(s, "*/"); end >= 0 {
				s = s[end+2:]
				continue
			}
			return ""
		}
		return s
	}
}
