package profiler

import (
	"context"
	"database/sql"
	"fmt"
	"strings"
)

// postgresProfiler implements Profiler against PostgreSQL.
type postgresProfiler struct{ db *sql.DB }

// NewPostgres returns a Profiler backed by the given *sql.DB (pgx/pq driver).
func NewPostgres(db *sql.DB) Profiler { return &postgresProfiler{db: db} }

func (p *postgresProfiler) BasicStats(ctx context.Context, schema, table, column string) (BasicStats, error) {
	if p == nil || p.db == nil {
		return BasicStats{}, errNoDB
	}
	var stats BasicStats
	row := p.db.QueryRowContext(ctx, fmt.Sprintf(`
		SELECT
			COUNT(*),
			COUNT(*) FILTER (WHERE %s IS NULL),
			COUNT(DISTINCT %s),
			MIN(%s)::text, MAX(%s)::text,
			AVG(%s::numeric), STDDEV_POP(%s::numeric)
		FROM %s.%s`,
		pgIdent(column), pgIdent(column), pgIdent(column), pgIdent(column),
		pgIdent(column), pgIdent(column), pgIdent(schema), pgIdent(table)))
	var minV, maxV sql.NullString
	var avg, std sql.NullFloat64
	if err := row.Scan(&stats.Count, &stats.NullCount, &stats.Distinct, &minV, &maxV, &avg, &std); err != nil {
		// AVG / STDDEV_POP fail on non-numeric columns; retry without them.
		row2 := p.db.QueryRowContext(ctx, fmt.Sprintf(`
			SELECT COUNT(*), COUNT(*) FILTER (WHERE %s IS NULL),
				COUNT(DISTINCT %s), MIN(%s)::text, MAX(%s)::text
			FROM %s.%s`,
			pgIdent(column), pgIdent(column), pgIdent(column), pgIdent(column),
			pgIdent(schema), pgIdent(table)))
		if err2 := row2.Scan(&stats.Count, &stats.NullCount, &stats.Distinct, &minV, &maxV); err2 != nil {
			return stats, err2
		}
	}
	if minV.Valid {
		stats.Min = minV.String
	}
	if maxV.Valid {
		stats.Max = maxV.String
	}
	if avg.Valid {
		stats.Avg = avg.Float64
	}
	if std.Valid {
		stats.StdDev = std.Float64
	}
	return stats, nil
}

func (p *postgresProfiler) Distribution(ctx context.Context, schema, table, column string, buckets int) (Histogram, error) {
	if p == nil || p.db == nil {
		return Histogram{}, errNoDB
	}
	if buckets <= 0 {
		buckets = 20
	}
	// NOTE: Distribution only works for numeric columns. For non-numeric columns,
	// callers should fall back to TopN. This CTE-based query assumes numeric type.
	query := fmt.Sprintf(`
		WITH bounds AS (
			SELECT MIN(%s::numeric) AS mn, MAX(%s::numeric) AS mx
			FROM %s.%s WHERE %s IS NOT NULL
		),
		bucketed AS (
			SELECT width_bucket(%s::numeric, b.mn, b.mx, %d) AS bkt, %s::numeric AS v
			FROM %s.%s
			CROSS JOIN bounds b
			WHERE %s IS NOT NULL
		)
		SELECT MIN(v), MAX(v), COUNT(*) FROM bucketed GROUP BY bkt ORDER BY bkt`,
		pgIdent(column), pgIdent(column), pgIdent(schema), pgIdent(table), pgIdent(column),
		pgIdent(column), buckets, pgIdent(column),
		pgIdent(schema), pgIdent(table), pgIdent(column))
	rows, err := p.db.QueryContext(ctx, query)
	if err != nil {
		return Histogram{}, err
	}
	defer rows.Close()
	var h Histogram
	for rows.Next() {
		var lo, hi sql.NullFloat64
		var cnt int64
		if err := rows.Scan(&lo, &hi, &cnt); err != nil {
			return h, err
		}
		h.Buckets = append(h.Buckets, HistogramBucket{LowerBound: lo.Float64, UpperBound: hi.Float64, Count: cnt})
	}
	return h, nil
}

func (p *postgresProfiler) TopN(ctx context.Context, schema, table, column string, n int) ([]ValueFreq, error) {
	if p == nil || p.db == nil {
		return nil, errNoDB
	}
	if n <= 0 {
		n = 10
	}
	rows, err := p.db.QueryContext(ctx, fmt.Sprintf(`
		SELECT %s::text, COUNT(*) FROM %s.%s
		WHERE %s IS NOT NULL
		GROUP BY %s ORDER BY COUNT(*) DESC LIMIT %d`,
		pgIdent(column), pgIdent(schema), pgIdent(table),
		pgIdent(column), pgIdent(column), n))
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var out []ValueFreq
	for rows.Next() {
		var v sql.NullString
		var c int64
		if err := rows.Scan(&v, &c); err != nil {
			return out, err
		}
		out = append(out, ValueFreq{Value: v.String, Count: c})
	}
	return out, rows.Err()
}

func (p *postgresProfiler) Patterns(ctx context.Context, schema, table, column string) ([]PatternMatch, error) {
	if p == nil || p.db == nil {
		return nil, errNoDB
	}
	var out []PatternMatch
	for _, pat := range commonPatterns {
		var cnt int64
		err := p.db.QueryRowContext(ctx, fmt.Sprintf(
			`SELECT COUNT(*) FROM %s.%s WHERE %s ~ $1`,
			pgIdent(schema), pgIdent(table), pgIdent(column)), pat.Regex).Scan(&cnt)
		if err != nil {
			// POSIX ~ may fail on non-text columns; skip the pattern.
			continue
		}
		out = append(out, PatternMatch{Pattern: pat.Name, Count: cnt})
	}
	return out, nil
}

// pgIdent quotes an identifier using PostgreSQL double quotes.
func pgIdent(s string) string { return "\"" + strings.ReplaceAll(s, "\"", "\"\"") + "\"" }
