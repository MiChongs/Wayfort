package dbquery

import (
	"context"
	"fmt"
	"strings"
)

// BuildRowsSQL validates table/ordering metadata and returns a dialect-quoted
// SELECT used by the browse-table endpoint. An optional filter substring
// builds a multi-column LIKE WHERE clause across every text-shaped column
// in the table — that's the BrowseTab "search" affordance.
func (s *Service) BuildRowsSQL(ctx context.Context, nodeID, userID uint64,
	database, schema, table, orderBy, orderDir string, limit, offset int) (string, error) {
	return s.BuildRowsSQLWithFilter(ctx, nodeID, userID, database, schema, table, orderBy, orderDir, "", limit, offset)
}

// BuildRowsSQLWithFilter is the extended form supporting a server-side
// substring filter. Empty filter is identical to BuildRowsSQL — added
// as a separate method (instead of adding a parameter and breaking
// callers in the same commit) so older audit / test paths keep working.
//
// The filter is applied as `colA::text ILIKE '%v%' OR colB::text ILIKE '%v%' ...`
// (PG) or `colA LIKE '%v%' OR colB LIKE '%v%' ...` (MySQL). Only text-
// shaped columns (CHAR / VARCHAR / TEXT / JSON / UUID) get included so
// big numeric / blob tables don't pay a full-table cast penalty.
func (s *Service) BuildRowsSQLWithFilter(ctx context.Context, nodeID, userID uint64,
	database, schema, table, orderBy, orderDir, filter string,
	limit, offset int) (string, error) {
	pl, err := s.getOrOpen(ctx, nodeID, userID, database)
	if err != nil {
		return "", err
	}
	cols, err := loadColumnsForPool(ctx, pl, schema, table)
	if err != nil {
		return "", err
	}
	if len(cols) == 0 {
		return "", fmt.Errorf("table %s.%s has no columns or doesn't exist", schema, table)
	}
	knownCols := map[string]bool{}
	for _, col := range cols {
		knownCols[col.Name] = true
	}
	if orderBy != "" && !knownCols[orderBy] {
		return "", fmt.Errorf("order_by column %q not in table", orderBy)
	}
	adapter, err := s.adapterForPool(pl)
	if err != nil {
		return "", err
	}
	base, err := adapter.Dialect().BuildRowsSQL(schema, table, orderBy, orderDir, limit, offset)
	if err != nil {
		return "", err
	}
	if filter == "" {
		return base, nil
	}
	// Inject a WHERE before ORDER BY / OFFSET. We rebuild instead of
	// patching to avoid fragile string surgery on the dialect's output.
	d := adapter.Dialect()
	textCols := []string{}
	for _, c := range cols {
		if isTextLikeType(c.Type) {
			textCols = append(textCols, c.Name)
		}
	}
	if len(textCols) == 0 {
		// No text columns to search — return the unfiltered SELECT so
		// the UI shows the page rather than an opaque empty result.
		return base, nil
	}
	whereExpr := buildLikeWhere(d, textCols, filter, pl.family())
	return buildRowsSelectSQLWithWhere(d, schema, table, whereExpr, orderBy, orderDir, limit, offset)
}

// buildLikeWhere assembles `colA::text ILIKE :1 OR colB::text ILIKE :1 …`
// (PG family) or `colA LIKE :1 OR colB LIKE :1 …` (MySQL). The pattern
// argument is inlined into a quoted literal because the dialect's
// positional placeholder isn't reusable inside an OR — using N copies
// would hurt prepared-statement cache hit-rate, and using string
// concatenation here is safe because filter is escaped.
func buildLikeWhere(d Dialect, cols []string, filter string, fam Family) string {
	op := "LIKE"
	cast := ""
	if fam == FamilyPostgres {
		op = "ILIKE"
		cast = "::text"
	}
	if fam == FamilyOracle {
		// DM doesn't have ILIKE; use UPPER + LIKE.
		// Built per-column below; rely on the col rendering branch.
	}
	pattern := "%" + escapeLike(filter) + "%"
	literal := "'" + strings.ReplaceAll(pattern, "'", "''") + "'"
	parts := make([]string, 0, len(cols))
	for _, c := range cols {
		col := d.QuoteIdent(c)
		if fam == FamilyOracle {
			parts = append(parts, "UPPER("+col+") LIKE UPPER("+literal+")")
		} else {
			parts = append(parts, col+cast+" "+op+" "+literal)
		}
	}
	return "(" + strings.Join(parts, " OR ") + ")"
}

// escapeLike defangs %, _, \ in the user-supplied filter so a literal
// `%` doesn't accidentally widen the match.
func escapeLike(s string) string {
	r := strings.NewReplacer(
		`\`, `\\`,
		`%`, `\%`,
		`_`, `\_`,
	)
	return r.Replace(s)
}

// buildRowsSelectSQLWithWhere is the same shape as adapter.go's
// buildRowsSelectSQL but accepts a pre-built WHERE expression. Each
// dialect adapter that overrides BuildRowsSQL must be re-implemented
// here when WHERE is needed; for the standard PG / MySQL path the
// generic builder below is correct.
func buildRowsSelectSQLWithWhere(d Dialect, schema, table, whereExpr, orderBy, orderDir string,
	limit, offset int) (string, error) {
	if d == nil {
		return "", fmt.Errorf("dbquery: dialect not configured")
	}
	if limit < 0 || offset < 0 {
		return "", fmt.Errorf("dbquery: limit and offset must be non-negative")
	}
	orderDir = strings.ToUpper(strings.TrimSpace(orderDir))
	if orderDir != "" && orderDir != "ASC" && orderDir != "DESC" {
		return "", fmt.Errorf("dbquery: order direction must be ASC or DESC")
	}
	q := "SELECT * FROM " + d.QuoteIdent(schema) + "." + d.QuoteIdent(table)
	if whereExpr != "" {
		q += " WHERE " + whereExpr
	}
	if orderBy != "" {
		q += " ORDER BY " + d.QuoteIdent(orderBy)
		if orderDir != "" {
			q += " " + orderDir
		}
	}
	q += fmt.Sprintf(" LIMIT %d OFFSET %d", limit, offset)
	return q, nil
}

// isTextLikeType decides whether a column type tag is searchable via
// LIKE. The detection is tag-prefix based because dialect adapters
// upper-case the DatabaseTypeName but otherwise pass it through.
func isTextLikeType(t string) bool {
	u := strings.ToUpper(t)
	for _, prefix := range []string{
		"CHAR", "VARCHAR", "TEXT", "CLOB", "JSON", "JSONB",
		"UUID", "XML", "ENUM", "SET", "STRING",
	} {
		if strings.HasPrefix(u, prefix) || strings.Contains(u, prefix) {
			return true
		}
	}
	return false
}

func (s *Service) adapterForPool(pl *pool) (Adapter, error) {
	if pl == nil {
		return nil, fmt.Errorf("dbquery: pool not initialized")
	}
	if pl.adapter != nil {
		return pl.adapter, nil
	}
	registry := s.registry
	if registry == nil {
		registry = DefaultRegistry()
	}
	adapter, ok := registry.Get(pl.protocol)
	if !ok {
		return nil, fmt.Errorf("dbquery: protocol %q not supported", pl.protocol)
	}
	return adapter, nil
}
