package dbquery

import (
	"context"
	"fmt"
	"strings"

)

// ForeignKeyInfo describes one FK constraint on a table. Direction
// "out" means this table's column references another; "in" means
// another table references this one.
type ForeignKeyInfo struct {
	Direction    string   `json:"direction"` // "out" | "in"
	Name         string   `json:"name"`
	FromSchema   string   `json:"from_schema"`
	FromTable    string   `json:"from_table"`
	FromColumns  []string `json:"from_columns"`
	ToSchema     string   `json:"to_schema"`
	ToTable      string   `json:"to_table"`
	ToColumns    []string `json:"to_columns"`
	OnUpdate     string   `json:"on_update"`
	OnDelete     string   `json:"on_delete"`
}

// TableStats is what the Structure panel renders at the top of the
// table detail. Row count is approximate (PG: pg_class.reltuples,
// MySQL: information_schema.TABLES.TABLE_ROWS) — exact counts on big
// tables are too expensive to gate on a tab switch.
type TableStats struct {
	RowsApprox int64  `json:"rows_approx"`
	TotalBytes int64  `json:"total_bytes"`
	DataBytes  int64  `json:"data_bytes"`
	IndexBytes int64  `json:"index_bytes"`
	// Engine / persistence-level info (mysql: ENGINE=InnoDB; pg: relpersistence)
	Engine string `json:"engine,omitempty"`
}

// LoadForeignKeys reads both outbound (this table → other) and inbound
// (other → this table) FKs in one shot. Both directions matter for a
// useful "structure" view; an operator looking at `users` wants to see
// "orders.user_id references this" too.
func (s *Service) LoadForeignKeys(ctx context.Context, nodeID, userID uint64,
	database, schema, table string) ([]ForeignKeyInfo, error) {
	pl, err := s.getOrOpen(ctx, nodeID, userID, database)
	if err != nil {
		return nil, err
	}
	switch pl.family() {
	case FamilyPostgres:
		return loadPostgresForeignKeys(ctx, pl, schema, table)
	case FamilyMySQL:
		return loadMysqlForeignKeys(ctx, pl, schema, table)
	case FamilyOracle:
		return loadDamengForeignKeys(ctx, pl, schema, table)
	}
	return nil, nil
}

// LoadTableStats returns approximate size + row count for one table.
func (s *Service) LoadTableStats(ctx context.Context, nodeID, userID uint64,
	database, schema, table string) (*TableStats, error) {
	pl, err := s.getOrOpen(ctx, nodeID, userID, database)
	if err != nil {
		return nil, err
	}
	switch pl.family() {
	case FamilyPostgres:
		return loadPostgresStats(ctx, pl, schema, table)
	case FamilyMySQL:
		return loadMysqlStats(ctx, pl, schema, table)
	case FamilyOracle:
		return loadDamengStats(ctx, pl, schema, table)
	}
	return nil, fmt.Errorf("dbquery: stats not implemented for %q", pl.protocol)
}

// LoadTableDDL returns the CREATE statement for the table. For MySQL we
// ask the server (SHOW CREATE TABLE — authoritative). For PostgreSQL
// there's no built-in, so we synthesise a faithful approximation from
// the catalog (column defs, defaults, NOT NULL, primary key, unique
// constraints, foreign keys). Comments are omitted; this DDL is for
// quick reference, not migration export.
func (s *Service) LoadTableDDL(ctx context.Context, nodeID, userID uint64,
	database, schema, table string) (string, error) {
	pl, err := s.getOrOpen(ctx, nodeID, userID, database)
	if err != nil {
		return "", err
	}
	switch pl.family() {
	case FamilyPostgres:
		return synthesisePostgresDDL(ctx, pl, schema, table)
	case FamilyMySQL:
		return loadMysqlDDL(ctx, pl, schema, table)
	case FamilyOracle:
		return loadDamengDDL(ctx, pl, schema, table)
	}
	return "", fmt.Errorf("dbquery: DDL not implemented for %q", pl.protocol)
}

// ----- postgres -----

func loadPostgresForeignKeys(ctx context.Context, pl *pool, schema, table string) ([]ForeignKeyInfo, error) {
	rows, err := pl.db.QueryContext(ctx, `
		WITH fk AS (
		  SELECT
		    c.conname,
		    n_from.nspname  AS from_schema,
		    t_from.relname  AS from_table,
		    n_to.nspname    AS to_schema,
		    t_to.relname    AS to_table,
		    pg_get_constraintdef(c.oid)         AS def,
		    array_agg(att_from.attname ORDER BY att_from.attnum)::text  AS from_cols,
		    array_agg(att_to.attname   ORDER BY att_to.attnum)::text    AS to_cols,
		    CASE c.confupdtype WHEN 'a' THEN 'NO ACTION' WHEN 'r' THEN 'RESTRICT'
		                        WHEN 'c' THEN 'CASCADE' WHEN 'n' THEN 'SET NULL'
		                        WHEN 'd' THEN 'SET DEFAULT' END AS on_update,
		    CASE c.confdeltype WHEN 'a' THEN 'NO ACTION' WHEN 'r' THEN 'RESTRICT'
		                        WHEN 'c' THEN 'CASCADE' WHEN 'n' THEN 'SET NULL'
		                        WHEN 'd' THEN 'SET DEFAULT' END AS on_delete
		  FROM pg_constraint c
		  JOIN pg_class      t_from ON t_from.oid = c.conrelid
		  JOIN pg_namespace  n_from ON n_from.oid = t_from.relnamespace
		  JOIN pg_class      t_to   ON t_to.oid = c.confrelid
		  JOIN pg_namespace  n_to   ON n_to.oid = t_to.relnamespace
		  JOIN unnest(c.conkey)  WITH ORDINALITY u_from(attnum, ord) ON true
		  JOIN unnest(c.confkey) WITH ORDINALITY u_to(attnum, ord)   ON u_to.ord = u_from.ord
		  JOIN pg_attribute  att_from ON att_from.attrelid = c.conrelid  AND att_from.attnum = u_from.attnum
		  JOIN pg_attribute  att_to   ON att_to.attrelid   = c.confrelid AND att_to.attnum   = u_to.attnum
		  WHERE c.contype = 'f'
		    AND ((n_from.nspname = $1 AND t_from.relname = $2)
		      OR (n_to.nspname = $1 AND t_to.relname = $2))
		  GROUP BY c.oid, c.conname, n_from.nspname, t_from.relname, n_to.nspname, t_to.relname, c.confupdtype, c.confdeltype
		)
		SELECT conname, from_schema, from_table, from_cols, to_schema, to_table, to_cols, on_update, on_delete
		FROM fk
		ORDER BY conname`, schema, table)
	if err != nil {
		return nil, fmt.Errorf("postgres fks: %w", err)
	}
	defer rows.Close()
	out := []ForeignKeyInfo{}
	for rows.Next() {
		var name, fs, ft, fc, ts, tt, tc, onU, onD string
		if err := rows.Scan(&name, &fs, &ft, &fc, &ts, &tt, &tc, &onU, &onD); err != nil {
			return nil, err
		}
		dir := "out"
		if fs != schema || ft != table {
			dir = "in"
		}
		out = append(out, ForeignKeyInfo{
			Direction: dir, Name: name,
			FromSchema: fs, FromTable: ft, FromColumns: splitPgArray(fc),
			ToSchema:   ts, ToTable: tt, ToColumns: splitPgArray(tc),
			OnUpdate: onU, OnDelete: onD,
		})
	}
	return out, rows.Err()
}

// splitPgArray parses `{a,b,c}` literal that pg returns when text-casting
// an array. Cheap pure-Go split — avoids importing a lib for the trivial
// case where values are simple identifiers (no commas inside names).
func splitPgArray(s string) []string {
	s = strings.TrimPrefix(strings.TrimSuffix(s, "}"), "{")
	if s == "" {
		return nil
	}
	return strings.Split(s, ",")
}

func loadPostgresStats(ctx context.Context, pl *pool, schema, table string) (*TableStats, error) {
	row := pl.db.QueryRowContext(ctx, `
		SELECT
		  COALESCE(c.reltuples::bigint, 0),
		  COALESCE(pg_total_relation_size(c.oid), 0),
		  COALESCE(pg_relation_size(c.oid), 0),
		  COALESCE(pg_indexes_size(c.oid), 0),
		  CASE c.relpersistence WHEN 'p' THEN 'permanent'
		                         WHEN 'u' THEN 'unlogged'
		                         WHEN 't' THEN 'temporary' END
		FROM pg_class c
		JOIN pg_namespace n ON n.oid = c.relnamespace
		WHERE n.nspname = $1 AND c.relname = $2`, schema, table)
	st := &TableStats{}
	if err := row.Scan(&st.RowsApprox, &st.TotalBytes, &st.DataBytes, &st.IndexBytes, &st.Engine); err != nil {
		return nil, fmt.Errorf("postgres stats: %w", err)
	}
	return st, nil
}

// synthesisePostgresDDL builds a single CREATE TABLE statement from
// pg_attribute + pg_constraint + pg_attrdef. It's intentionally a
// best-effort reconstruction; behaviour is faithful to pg_dump for
// common cases (column types, defaults, NOT NULL, PK, UNIQUE, FK).
// Extensions (partitions, inheritance, exclusion constraints, identity
// columns) are surfaced as comments rather than perfectly emitted.
func synthesisePostgresDDL(ctx context.Context, pl *pool, schema, table string) (string, error) {
	// 1. Columns
	colRows, err := pl.db.QueryContext(ctx, `
		SELECT a.attname,
		       format_type(a.atttypid, a.atttypmod),
		       NOT a.attnotnull,
		       COALESCE(pg_get_expr(d.adbin, d.adrelid), '') AS default_value,
		       a.attidentity
		FROM pg_attribute a
		JOIN pg_class c ON c.oid = a.attrelid
		JOIN pg_namespace n ON n.oid = c.relnamespace
		LEFT JOIN pg_attrdef d ON d.adrelid = a.attrelid AND d.adnum = a.attnum
		WHERE n.nspname = $1 AND c.relname = $2 AND a.attnum > 0 AND NOT a.attisdropped
		ORDER BY a.attnum`, schema, table)
	if err != nil {
		return "", err
	}
	defer colRows.Close()
	cols := []string{}
	for colRows.Next() {
		var name, typ, def, identity string
		var nullable bool
		if err := colRows.Scan(&name, &typ, &nullable, &def, &identity); err != nil {
			return "", err
		}
		piece := fmt.Sprintf("  %s %s", pgQuoteIdent(name), typ)
		if identity == "a" {
			piece += " GENERATED ALWAYS AS IDENTITY"
		} else if identity == "d" {
			piece += " GENERATED BY DEFAULT AS IDENTITY"
		} else if def != "" {
			piece += " DEFAULT " + def
		}
		if !nullable {
			piece += " NOT NULL"
		}
		cols = append(cols, piece)
	}

	// 2. Constraints (PK / UNIQUE / CHECK / FK) — pg_get_constraintdef
	//    returns the SQL fragment exactly. contype is the pg "char" SQL
	//    type — a one-byte ASCII char. pgx stdlib hands it back as a
	//    Go string, not uint8, so we scan into string and we keep it
	//    only to drive ORDER BY (server-side); the rendered constraint
	//    body comes from pg_get_constraintdef which knows the type.
	consRows, err := pl.db.QueryContext(ctx, `
		SELECT conname, pg_get_constraintdef(c.oid)
		FROM pg_constraint c
		JOIN pg_class t ON t.oid = c.conrelid
		JOIN pg_namespace n ON n.oid = t.relnamespace
		WHERE n.nspname = $1 AND t.relname = $2
		ORDER BY CASE c.contype WHEN 'p' THEN 1 WHEN 'u' THEN 2
		                        WHEN 'f' THEN 3 WHEN 'c' THEN 4 ELSE 5 END,
		         conname`, schema, table)
	if err != nil {
		return "", err
	}
	defer consRows.Close()
	for consRows.Next() {
		var name, def string
		if err := consRows.Scan(&name, &def); err != nil {
			return "", err
		}
		cols = append(cols, fmt.Sprintf("  CONSTRAINT %s %s", pgQuoteIdent(name), def))
	}

	body := strings.Join(cols, ",\n")
	full := fmt.Sprintf("CREATE TABLE %s.%s (\n%s\n);\n",
		pgQuoteIdent(schema), pgQuoteIdent(table), body)

	// 3. Indexes (non-constraint-backed) — append below
	idxRows, err := pl.db.QueryContext(ctx, `
		SELECT pg_get_indexdef(i.oid)
		FROM pg_index ix
		JOIN pg_class i ON i.oid = ix.indexrelid
		JOIN pg_class t ON t.oid = ix.indrelid
		JOIN pg_namespace n ON n.oid = t.relnamespace
		WHERE n.nspname = $1 AND t.relname = $2
		  AND NOT ix.indisprimary
		  AND NOT EXISTS (
		    SELECT 1 FROM pg_constraint c
		    WHERE c.conindid = i.oid AND c.contype = 'u'
		  )
		ORDER BY i.relname`, schema, table)
	if err == nil {
		defer idxRows.Close()
		for idxRows.Next() {
			var def string
			if err := idxRows.Scan(&def); err == nil {
				full += def + ";\n"
			}
		}
	}
	return full, nil
}

func pgQuoteIdent(s string) string {
	return `"` + strings.ReplaceAll(s, `"`, `""`) + `"`
}

// ----- mysql -----

func loadMysqlForeignKeys(ctx context.Context, pl *pool, schema, table string) ([]ForeignKeyInfo, error) {
	rows, err := pl.db.QueryContext(ctx, `
		SELECT
		  rc.CONSTRAINT_NAME,
		  kcu.TABLE_SCHEMA,
		  kcu.TABLE_NAME,
		  GROUP_CONCAT(kcu.COLUMN_NAME ORDER BY kcu.ORDINAL_POSITION),
		  kcu.REFERENCED_TABLE_SCHEMA,
		  kcu.REFERENCED_TABLE_NAME,
		  GROUP_CONCAT(kcu.REFERENCED_COLUMN_NAME ORDER BY kcu.ORDINAL_POSITION),
		  rc.UPDATE_RULE,
		  rc.DELETE_RULE
		FROM information_schema.REFERENTIAL_CONSTRAINTS rc
		JOIN information_schema.KEY_COLUMN_USAGE kcu
		  ON kcu.CONSTRAINT_SCHEMA = rc.CONSTRAINT_SCHEMA
		 AND kcu.CONSTRAINT_NAME   = rc.CONSTRAINT_NAME
		WHERE
		  (kcu.TABLE_SCHEMA = ? AND kcu.TABLE_NAME = ?)
		  OR (kcu.REFERENCED_TABLE_SCHEMA = ? AND kcu.REFERENCED_TABLE_NAME = ?)
		GROUP BY rc.CONSTRAINT_NAME, kcu.TABLE_SCHEMA, kcu.TABLE_NAME,
		         kcu.REFERENCED_TABLE_SCHEMA, kcu.REFERENCED_TABLE_NAME,
		         rc.UPDATE_RULE, rc.DELETE_RULE
		ORDER BY rc.CONSTRAINT_NAME`, schema, table, schema, table)
	if err != nil {
		return nil, fmt.Errorf("mysql fks: %w", err)
	}
	defer rows.Close()
	out := []ForeignKeyInfo{}
	for rows.Next() {
		var name, fs, ft, fc, ts, tt, tc, onU, onD string
		if err := rows.Scan(&name, &fs, &ft, &fc, &ts, &tt, &tc, &onU, &onD); err != nil {
			return nil, err
		}
		dir := "out"
		if fs != schema || ft != table {
			dir = "in"
		}
		out = append(out, ForeignKeyInfo{
			Direction: dir, Name: name,
			FromSchema: fs, FromTable: ft, FromColumns: strings.Split(fc, ","),
			ToSchema:   ts, ToTable: tt, ToColumns: strings.Split(tc, ","),
			OnUpdate: onU, OnDelete: onD,
		})
	}
	return out, rows.Err()
}

func loadMysqlStats(ctx context.Context, pl *pool, schema, table string) (*TableStats, error) {
	row := pl.db.QueryRowContext(ctx, `
		SELECT
		  COALESCE(TABLE_ROWS, 0),
		  COALESCE(DATA_LENGTH + INDEX_LENGTH, 0),
		  COALESCE(DATA_LENGTH, 0),
		  COALESCE(INDEX_LENGTH, 0),
		  COALESCE(ENGINE, '')
		FROM information_schema.TABLES
		WHERE TABLE_SCHEMA = ? AND TABLE_NAME = ?`, schema, table)
	st := &TableStats{}
	if err := row.Scan(&st.RowsApprox, &st.TotalBytes, &st.DataBytes, &st.IndexBytes, &st.Engine); err != nil {
		return nil, fmt.Errorf("mysql stats: %w", err)
	}
	return st, nil
}

func loadMysqlDDL(ctx context.Context, pl *pool, schema, table string) (string, error) {
	// SHOW CREATE TABLE returns two columns: table name, ddl text.
	row := pl.db.QueryRowContext(ctx, fmt.Sprintf("SHOW CREATE TABLE `%s`.`%s`",
		strings.ReplaceAll(schema, "`", "``"),
		strings.ReplaceAll(table, "`", "``")))
	var name, ddl string
	if err := row.Scan(&name, &ddl); err != nil {
		return "", fmt.Errorf("mysql ddl: %w", err)
	}
	return ddl + ";\n", nil
}
