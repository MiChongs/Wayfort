package profiler

import (
	"context"
	"database/sql"
	"fmt"
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
	// PostgreSQL: compute the numeric range once, then bucket with width_bucket().
	rows, err := p.db.QueryContext(ctx, fmt.Sprintf(`
		SELECT lower, upper, cnt FROM (
			SELECT
				width_bucket(%s::numeric, mn, mx, %d) AS b,
				MIN(%s::numeric) AS lower, MAX(%s::numeric) AS upper,
				COUNT(*) AS cnt,
				MIN(%s::numeric) OVER () AS mn, MAX(%s::numeric) OVER () AS mx
			FROM %s.%s WHERE %s IS NOT NULL
		) t GROUP BY b, lower, upper ORDER BY b`,
		pgIdent(column), buckets,
		pgIdent(column), pgIdent(column),
		pgIdent(column), pgIdent(column),
		pgIdent(schema), pgIdent(table), pgIdent(column)))
	if err != nil {
		return Histogram{}, err
	}
	defer rows.Close()
	var h Histogram
	for rows.Next() {
		var lo, hi sql.NullString
		var cnt int64
		if err := rows.Scan(&lo, &hi, &cnt); err != nil {
			return h, err
		}
		h.Buckets = append(h.Buckets, HistogramBucket{LowerBound: lo.String, UpperBound: hi.String, Count: cnt})
	}
	return h, rows.Err()
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
func pgIdent(s string) string { return "\"" + s + "\"" }
