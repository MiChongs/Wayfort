package dbquery

import (
	"context"
	"fmt"
)

// ColumnStats is the per-column summary returned by ColumnStats — the
// payload of the "click a column header → data summary" popover.
// Fields are best-effort; numeric extremes are absent for non-numeric
// columns (the strings are empty when no range applies). TopValues is
// always populated when the table is non-empty.
type ColumnStats struct {
	Column      string         `json:"column"`
	DistinctCnt int64          `json:"distinct_count"`
	NullCnt     int64          `json:"null_count"`
	TotalCnt    int64          `json:"total_count"`
	MinValue    string         `json:"min_value,omitempty"`
	MaxValue    string         `json:"max_value,omitempty"`
	TopValues   []ColumnValueFreq `json:"top_values"`
}

// ColumnValueFreq is one row of the "top N values" sample. Value is
// the cell text (NULL is rendered as the literal string "NULL" by
// the frontend); Frequency is the COUNT(*) for that value.
type ColumnValueFreq struct {
	Value     string `json:"value"`
	Frequency int64  `json:"frequency"`
}

// LoadColumnStats runs a single batch of aggregates against the
// (schema, table, column) triple. We deliberately fire three small
// queries instead of one fancy CTE so a missing privilege (e.g. no
// SELECT on the table) surfaces a clean per-step error rather than
// a 500 from the aggregate path.
//
// The numeric range query runs ONLY when the column type tag matches
// a numeric / temporal shape — issuing MIN/MAX on JSON columns is
// expensive on PG and outright invalid on some MySQL versions.
func (s *Service) LoadColumnStats(ctx context.Context, nodeID, userID uint64,
	database, schema, table, column string, topN int) (*ColumnStats, error) {
	pl, err := s.getOrOpen(ctx, nodeID, userID, database)
	if err != nil {
		return nil, err
	}
	cols, err := loadColumnsForPool(ctx, pl, schema, table)
	if err != nil {
		return nil, err
	}
	var colMeta *ColumnInfo
	for i := range cols {
		if cols[i].Name == column {
			colMeta = &cols[i]
			break
		}
	}
	if colMeta == nil {
		return nil, fmt.Errorf("column %q not found in %s.%s", column, schema, table)
	}
	if topN <= 0 || topN > 50 {
		topN = 10
	}
	adapter, err := s.adapterForPool(pl)
	if err != nil {
		return nil, err
	}
	d := adapter.Dialect()
	qt := d.QuoteIdent(table)
	qs := d.QuoteIdent(schema)
	qc := d.QuoteIdent(column)
	tbl := qs + "." + qt
	out := &ColumnStats{Column: column}

	// 1. Total / distinct / null counts.
	err = pl.db.QueryRowContext(ctx, fmt.Sprintf(
		"SELECT COUNT(*), COUNT(DISTINCT %s), SUM(CASE WHEN %s IS NULL THEN 1 ELSE 0 END) FROM %s",
		qc, qc, tbl,
	)).Scan(&out.TotalCnt, &out.DistinctCnt, &out.NullCnt)
	if err != nil {
		return nil, fmt.Errorf("column stats counts: %w", err)
	}

	// 2. Min / Max for numeric / temporal columns.
	if isOrderableType(colMeta.Type) {
		var minV, maxV any
		err = pl.db.QueryRowContext(ctx, fmt.Sprintf(
			"SELECT MIN(%s)::text, MAX(%s)::text FROM %s WHERE %s IS NOT NULL",
			qc, qc, tbl, qc,
		)).Scan(&minV, &maxV)
		if err != nil {
			// MySQL doesn't support `::text` cast; retry without.
			err = pl.db.QueryRowContext(ctx, fmt.Sprintf(
				"SELECT MIN(%s), MAX(%s) FROM %s WHERE %s IS NOT NULL",
				qc, qc, tbl, qc,
			)).Scan(&minV, &maxV)
		}
		if err == nil {
			out.MinValue = stringifyScan(minV)
			out.MaxValue = stringifyScan(maxV)
		}
	}

	// 3. Top values by frequency.
	rows, err := pl.db.QueryContext(ctx, fmt.Sprintf(
		"SELECT %s, COUNT(*) AS freq FROM %s WHERE %s IS NOT NULL GROUP BY %s ORDER BY freq DESC LIMIT %d",
		qc, tbl, qc, qc, topN,
	))
	if err != nil {
		return nil, fmt.Errorf("column stats top values: %w", err)
	}
	defer rows.Close()
	for rows.Next() {
		var v any
		var freq int64
		if err := rows.Scan(&v, &freq); err != nil {
			return nil, err
		}
		out.TopValues = append(out.TopValues, ColumnValueFreq{
			Value:     stringifyScan(v),
			Frequency: freq,
		})
	}
	return out, rows.Err()
}

// isOrderableType decides whether MIN/MAX makes sense. The detection
// is conservative — only types that have a total ordering across all
// real DBs (numbers, dates, times, char).
func isOrderableType(t string) bool {
	switch {
	case isTextLikeType(t):
		// VARCHAR / TEXT have a lex ordering; MIN/MAX returns the first
		// and last in sort order — usable for date-like strings too.
		return true
	}
	for _, p := range []string{
		"INT", "FLOAT", "DOUBLE", "REAL", "NUMERIC", "DECIMAL", "NUMBER",
		"BIGINT", "SMALLINT", "TINYINT", "MEDIUMINT",
		"DATE", "TIME", "TIMESTAMP", "INTERVAL",
		"MONEY", "YEAR",
	} {
		if len(t) >= len(p) && t[:len(p)] == p {
			return true
		}
		if contains(t, p) {
			return true
		}
	}
	return false
}

func contains(haystack, needle string) bool {
	if len(needle) > len(haystack) {
		return false
	}
	for i := 0; i+len(needle) <= len(haystack); i++ {
		if haystack[i:i+len(needle)] == needle {
			return true
		}
	}
	return false
}

func stringifyScan(v any) string {
	if v == nil {
		return ""
	}
	switch x := v.(type) {
	case []byte:
		return string(x)
	case string:
		return x
	}
	return fmt.Sprintf("%v", v)
}
