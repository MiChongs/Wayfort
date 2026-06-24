package profiler

import (
	"context"
	"database/sql"
	"fmt"
	"strings"
)

// mysqlProfiler implements Profiler against MySQL/MariaDB.
type mysqlProfiler struct{ db *sql.DB }

// NewMySQL returns a Profiler backed by the given *sql.DB (MySQL driver).
func NewMySQL(db *sql.DB) Profiler { return &mysqlProfiler{db: db} }

func (p *mysqlProfiler) BasicStats(ctx context.Context, schema, table, column string) (BasicStats, error) {
	if p == nil || p.db == nil {
		return BasicStats{}, errNoDB
	}
	var stats BasicStats
	row := p.db.QueryRowContext(ctx, fmt.Sprintf(`
		SELECT
			COUNT(*),
			SUM(CASE WHEN %s IS NULL THEN 1 ELSE 0 END),
			COUNT(DISTINCT %s),
			MIN(%s), MAX(%s),
			AVG(CAST(%s AS DECIMAL(38,10))), STDDEV(CAST(%s AS DECIMAL(38,10)))
		FROM %s.%s`,
		mysqlIdent(column), mysqlIdent(column), mysqlIdent(column), mysqlIdent(column),
		mysqlIdent(column), mysqlIdent(column), mysqlIdent(schema), mysqlIdent(table)))
	var minV, maxV sql.NullString
	var avg, std sql.NullFloat64
	if err := row.Scan(&stats.Count, &stats.NullCount, &stats.Distinct, &minV, &maxV, &avg, &std); err != nil {
		// AVG / STDDEV fail on non-numeric columns; retry without them.
		row2 := p.db.QueryRowContext(ctx, fmt.Sprintf(`
			SELECT COUNT(*), SUM(CASE WHEN %s IS NULL THEN 1 ELSE 0 END),
				COUNT(DISTINCT %s), MIN(%s), MAX(%s)
			FROM %s.%s`,
			mysqlIdent(column), mysqlIdent(column), mysqlIdent(column), mysqlIdent(column),
			mysqlIdent(schema), mysqlIdent(table)))
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

func (p *mysqlProfiler) Distribution(ctx context.Context, schema, table, column string, buckets int) (Histogram, error) {
	if p == nil || p.db == nil {
		return Histogram{}, errNoDB
	}
	if buckets <= 0 {
		buckets = 20
	}
	rows, err := p.db.QueryContext(ctx, fmt.Sprintf(`
		WITH bucketed AS (
			SELECT %s AS v, NTILE(%d) OVER (ORDER BY %s) AS b
			FROM %s.%s
			WHERE %s IS NOT NULL
		)
		SELECT MIN(v), MAX(v), COUNT(*) FROM bucketed GROUP BY b ORDER BY b`,
		mysqlIdent(column), buckets, mysqlIdent(column),
		mysqlIdent(schema), mysqlIdent(table), mysqlIdent(column)))
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

func (p *mysqlProfiler) TopN(ctx context.Context, schema, table, column string, n int) ([]ValueFreq, error) {
	if p == nil || p.db == nil {
		return nil, errNoDB
	}
	if n <= 0 {
		n = 10
	}
	rows, err := p.db.QueryContext(ctx, fmt.Sprintf(`
		SELECT %s, COUNT(*) FROM %s.%s
		WHERE %s IS NOT NULL
		GROUP BY %s ORDER BY COUNT(*) DESC LIMIT %d`,
		mysqlIdent(column), mysqlIdent(schema), mysqlIdent(table),
		mysqlIdent(column), mysqlIdent(column), n))
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

func (p *mysqlProfiler) Patterns(ctx context.Context, schema, table, column string) ([]PatternMatch, error) {
	if p == nil || p.db == nil {
		return nil, errNoDB
	}
	var out []PatternMatch
	for _, pat := range commonPatterns {
		var cnt int64
		err := p.db.QueryRowContext(ctx, fmt.Sprintf(
			`SELECT COUNT(*) FROM %s.%s WHERE %s REGEXP ?`,
			mysqlIdent(schema), mysqlIdent(table), mysqlIdent(column)), pat.Regex).Scan(&cnt)
		if err != nil {
			// REGEXP may fail on binary columns; skip the pattern.
			continue
		}
		out = append(out, PatternMatch{Pattern: pat.Name, Count: cnt})
	}
	return out, nil
}

// mysqlIdent quotes an identifier using MySQL backticks.
func mysqlIdent(s string) string { return "`" + strings.ReplaceAll(s, "`", "``") + "`" }
