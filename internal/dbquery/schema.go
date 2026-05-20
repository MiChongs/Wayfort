package dbquery

import (
	"context"
	"fmt"

	"github.com/michongs/jumpserver-anonymous/internal/model"
)

// SchemaInfo groups what the UI needs to render the left-side schema
// tree. Returned as one shot for a node so the front-end can flatten +
// render without N+1 calls.
type SchemaInfo struct {
	// CurrentDB is what the active connection is in. For postgres it's
	// the database name; for mysql it's the schema (since "database" and
	// "schema" are aliases there).
	CurrentDB string         `json:"current_database"`
	Databases []DatabaseInfo `json:"databases"`
}

// DatabaseInfo is one database / schema entry. For postgres `Name` is
// the schema name (public, info, ...). For mysql it's the database name.
type DatabaseInfo struct {
	Name   string      `json:"name"`
	Tables []TableInfo `json:"tables"`
}

// TableInfo is one table row in the sidebar. The handler trims columns
// to the cheap metadata so the initial render is fast; full column
// details come from a separate per-table fetch.
type TableInfo struct {
	Schema string `json:"schema"`
	Name   string `json:"name"`
	Kind   string `json:"kind"` // "table" | "view" | "matview"
}

// ColumnInfo describes one column for the per-table detail view.
type ColumnInfo struct {
	Name          string  `json:"name"`
	Type          string  `json:"type"`
	Nullable      bool    `json:"nullable"`
	IsPrimaryKey  bool    `json:"is_primary_key"`
	DefaultValue  *string `json:"default_value,omitempty"`
	OrdinalPos    int     `json:"ordinal_position"`
}

// IndexInfo summarises an index for the table detail view.
type IndexInfo struct {
	Name      string   `json:"name"`
	IsPrimary bool     `json:"is_primary"`
	IsUnique  bool     `json:"is_unique"`
	Columns   []string `json:"columns"`
}

// ListDatabases returns the names of every database the connection is
// allowed to see at the *cluster* level. For PostgreSQL we must open
// a connection (defaulting to the bootstrap "postgres" DB) and read
// pg_database; the result is then passed back to LoadSchema as the
// per-call database param so each row's structure can be browsed.
//
// For MySQL the per-connection "database" is the same concept as
// PostgreSQL's "schema" — so "SHOW DATABASES" returns what the user
// expects to see in the picker, and LoadSchema's information_schema
// query is already cluster-wide.
func (s *Service) ListDatabases(ctx context.Context, nodeID, userID uint64) ([]string, error) {
	// Use empty database → falls back to driver default / proto_options.
	// For PG this is whatever the node's proto_options names (often
	// "postgres" — the only DB guaranteed to exist on a fresh cluster).
	pl, err := s.getOrOpen(ctx, nodeID, userID, "")
	if err != nil {
		return nil, err
	}
	var q string
	switch pl.protocol {
	case model.NodeProtoPostgres:
		// datistemplate: hide template0 / template1
		// datallowconn:  hide databases the connection can't open
		q = `SELECT datname FROM pg_database WHERE NOT datistemplate AND datallowconn ORDER BY datname`
	case model.NodeProtoMySQL:
		q = `SELECT SCHEMA_NAME FROM information_schema.SCHEMATA WHERE SCHEMA_NAME NOT IN ('mysql','information_schema','performance_schema','sys') ORDER BY SCHEMA_NAME`
	default:
		return nil, fmt.Errorf("dbquery: protocol %q list databases not implemented", pl.protocol)
	}
	rows, err := pl.db.QueryContext(ctx, q)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := []string{}
	for rows.Next() {
		var name string
		if err := rows.Scan(&name); err != nil {
			return nil, err
		}
		out = append(out, name)
	}
	return out, rows.Err()
}

// LoadSchema returns the schema tree for a (node, database). For
// PostgreSQL `database` is the catalog name (each catalog is a separate
// pool); for MySQL it's optional — empty means "every non-system schema".
func (s *Service) LoadSchema(ctx context.Context, nodeID, userID uint64, database string) (*SchemaInfo, error) {
	pl, err := s.getOrOpen(ctx, nodeID, userID, database)
	if err != nil {
		return nil, err
	}
	switch pl.protocol {
	case model.NodeProtoPostgres:
		return loadPostgresSchema(ctx, pl)
	case model.NodeProtoMySQL:
		return loadMysqlSchema(ctx, pl)
	}
	return nil, fmt.Errorf("dbquery: protocol %q schema not implemented", pl.protocol)
}

// LoadColumns returns the detailed column list for one table.
func (s *Service) LoadColumns(ctx context.Context, nodeID, userID uint64,
	database, schema, table string) ([]ColumnInfo, error) {
	pl, err := s.getOrOpen(ctx, nodeID, userID, database)
	if err != nil {
		return nil, err
	}
	switch pl.protocol {
	case model.NodeProtoPostgres:
		return loadPostgresColumns(ctx, pl, schema, table)
	case model.NodeProtoMySQL:
		return loadMysqlColumns(ctx, pl, schema, table)
	}
	return nil, fmt.Errorf("dbquery: protocol %q columns not implemented", pl.protocol)
}

// LoadIndexes returns indexes for one table.
func (s *Service) LoadIndexes(ctx context.Context, nodeID, userID uint64,
	database, schema, table string) ([]IndexInfo, error) {
	pl, err := s.getOrOpen(ctx, nodeID, userID, database)
	if err != nil {
		return nil, err
	}
	switch pl.protocol {
	case model.NodeProtoPostgres:
		return loadPostgresIndexes(ctx, pl, schema, table)
	case model.NodeProtoMySQL:
		return loadMysqlIndexes(ctx, pl, schema, table)
	}
	return nil, nil
}

// ----- postgres --------------------------------------------------------------

func loadPostgresSchema(ctx context.Context, pl *pool) (*SchemaInfo, error) {
	var current string
	if err := pl.db.QueryRowContext(ctx, "SELECT current_database()").Scan(&current); err != nil {
		return nil, fmt.Errorf("postgres current_database: %w", err)
	}
	rows, err := pl.db.QueryContext(ctx, `
		SELECT n.nspname, c.relname,
		       CASE c.relkind WHEN 'r' THEN 'table'
		                      WHEN 'v' THEN 'view'
		                      WHEN 'm' THEN 'matview'
		                      WHEN 'p' THEN 'table'
		                      ELSE c.relkind::text END
		FROM pg_class c
		JOIN pg_namespace n ON n.oid = c.relnamespace
		WHERE c.relkind IN ('r','v','m','p')
		  AND n.nspname NOT IN ('pg_catalog','information_schema')
		  AND n.nspname NOT LIKE 'pg_toast%'
		ORDER BY n.nspname, c.relname`)
	if err != nil {
		return nil, fmt.Errorf("postgres list tables: %w", err)
	}
	defer rows.Close()
	bySchema := map[string][]TableInfo{}
	order := []string{}
	for rows.Next() {
		var schema, name, kind string
		if err := rows.Scan(&schema, &name, &kind); err != nil {
			return nil, err
		}
		if _, ok := bySchema[schema]; !ok {
			order = append(order, schema)
		}
		bySchema[schema] = append(bySchema[schema], TableInfo{Schema: schema, Name: name, Kind: kind})
	}
	dbs := make([]DatabaseInfo, 0, len(order))
	for _, schema := range order {
		dbs = append(dbs, DatabaseInfo{Name: schema, Tables: bySchema[schema]})
	}
	return &SchemaInfo{CurrentDB: current, Databases: dbs}, nil
}

func loadPostgresColumns(ctx context.Context, pl *pool, schema, table string) ([]ColumnInfo, error) {
	rows, err := pl.db.QueryContext(ctx, `
		SELECT a.attname,
		       format_type(a.atttypid, a.atttypmod),
		       NOT a.attnotnull,
		       COALESCE(pg_get_expr(d.adbin, d.adrelid), '') AS default_value,
		       a.attnum,
		       COALESCE((SELECT true FROM pg_index i
		                 WHERE i.indrelid = a.attrelid
		                   AND i.indisprimary
		                   AND a.attnum = ANY(i.indkey)), false) AS is_pk
		FROM pg_attribute a
		JOIN pg_class c ON c.oid = a.attrelid
		JOIN pg_namespace n ON n.oid = c.relnamespace
		LEFT JOIN pg_attrdef d ON d.adrelid = a.attrelid AND d.adnum = a.attnum
		WHERE n.nspname = $1 AND c.relname = $2 AND a.attnum > 0 AND NOT a.attisdropped
		ORDER BY a.attnum`, schema, table)
	if err != nil {
		return nil, fmt.Errorf("postgres columns: %w", err)
	}
	defer rows.Close()
	out := []ColumnInfo{}
	for rows.Next() {
		var c ColumnInfo
		var def string
		if err := rows.Scan(&c.Name, &c.Type, &c.Nullable, &def, &c.OrdinalPos, &c.IsPrimaryKey); err != nil {
			return nil, err
		}
		if def != "" {
			d := def
			c.DefaultValue = &d
		}
		out = append(out, c)
	}
	return out, rows.Err()
}

func loadPostgresIndexes(ctx context.Context, pl *pool, schema, table string) ([]IndexInfo, error) {
	rows, err := pl.db.QueryContext(ctx, `
		SELECT i.relname,
		       ix.indisprimary,
		       ix.indisunique,
		       array_to_string(array_agg(a.attname ORDER BY array_position(ix.indkey, a.attnum)), ',')
		FROM pg_index ix
		JOIN pg_class i ON i.oid = ix.indexrelid
		JOIN pg_class t ON t.oid = ix.indrelid
		JOIN pg_namespace n ON n.oid = t.relnamespace
		JOIN pg_attribute a ON a.attrelid = t.oid AND a.attnum = ANY(ix.indkey)
		WHERE n.nspname = $1 AND t.relname = $2
		GROUP BY i.relname, ix.indisprimary, ix.indisunique
		ORDER BY ix.indisprimary DESC, i.relname`, schema, table)
	if err != nil {
		return nil, fmt.Errorf("postgres indexes: %w", err)
	}
	defer rows.Close()
	out := []IndexInfo{}
	for rows.Next() {
		var idx IndexInfo
		var colsCSV string
		if err := rows.Scan(&idx.Name, &idx.IsPrimary, &idx.IsUnique, &colsCSV); err != nil {
			return nil, err
		}
		idx.Columns = splitCSV(colsCSV)
		out = append(out, idx)
	}
	return out, rows.Err()
}

// ----- mysql ----------------------------------------------------------------

func loadMysqlSchema(ctx context.Context, pl *pool) (*SchemaInfo, error) {
	var current string
	if err := pl.db.QueryRowContext(ctx, "SELECT DATABASE()").Scan(&current); err != nil {
		// Empty result is fine — fresh connection without USE.
		current = ""
	}
	rows, err := pl.db.QueryContext(ctx, `
		SELECT TABLE_SCHEMA, TABLE_NAME,
		       LOWER(REPLACE(TABLE_TYPE, ' ', '_'))
		FROM information_schema.TABLES
		WHERE TABLE_SCHEMA NOT IN ('mysql','information_schema','performance_schema','sys')
		ORDER BY TABLE_SCHEMA, TABLE_NAME`)
	if err != nil {
		return nil, fmt.Errorf("mysql list tables: %w", err)
	}
	defer rows.Close()
	bySchema := map[string][]TableInfo{}
	order := []string{}
	for rows.Next() {
		var schema, name, kind string
		if err := rows.Scan(&schema, &name, &kind); err != nil {
			return nil, err
		}
		// MySQL TABLE_TYPE values: BASE TABLE / VIEW. Normalise to ours.
		switch kind {
		case "base_table":
			kind = "table"
		case "view":
			kind = "view"
		}
		if _, ok := bySchema[schema]; !ok {
			order = append(order, schema)
		}
		bySchema[schema] = append(bySchema[schema], TableInfo{Schema: schema, Name: name, Kind: kind})
	}
	dbs := make([]DatabaseInfo, 0, len(order))
	for _, schema := range order {
		dbs = append(dbs, DatabaseInfo{Name: schema, Tables: bySchema[schema]})
	}
	return &SchemaInfo{CurrentDB: current, Databases: dbs}, nil
}

func loadMysqlColumns(ctx context.Context, pl *pool, schema, table string) ([]ColumnInfo, error) {
	rows, err := pl.db.QueryContext(ctx, `
		SELECT COLUMN_NAME, COLUMN_TYPE,
		       IS_NULLABLE = 'YES',
		       COALESCE(COLUMN_DEFAULT, ''),
		       ORDINAL_POSITION,
		       COLUMN_KEY = 'PRI'
		FROM information_schema.COLUMNS
		WHERE TABLE_SCHEMA = ? AND TABLE_NAME = ?
		ORDER BY ORDINAL_POSITION`, schema, table)
	if err != nil {
		return nil, fmt.Errorf("mysql columns: %w", err)
	}
	defer rows.Close()
	out := []ColumnInfo{}
	for rows.Next() {
		var c ColumnInfo
		var def string
		if err := rows.Scan(&c.Name, &c.Type, &c.Nullable, &def, &c.OrdinalPos, &c.IsPrimaryKey); err != nil {
			return nil, err
		}
		if def != "" {
			d := def
			c.DefaultValue = &d
		}
		out = append(out, c)
	}
	return out, rows.Err()
}

func loadMysqlIndexes(ctx context.Context, pl *pool, schema, table string) ([]IndexInfo, error) {
	rows, err := pl.db.QueryContext(ctx, `
		SELECT INDEX_NAME,
		       INDEX_NAME = 'PRIMARY',
		       NON_UNIQUE = 0,
		       GROUP_CONCAT(COLUMN_NAME ORDER BY SEQ_IN_INDEX)
		FROM information_schema.STATISTICS
		WHERE TABLE_SCHEMA = ? AND TABLE_NAME = ?
		GROUP BY INDEX_NAME, NON_UNIQUE
		ORDER BY INDEX_NAME = 'PRIMARY' DESC, INDEX_NAME`, schema, table)
	if err != nil {
		return nil, fmt.Errorf("mysql indexes: %w", err)
	}
	defer rows.Close()
	out := []IndexInfo{}
	for rows.Next() {
		var idx IndexInfo
		var colsCSV string
		if err := rows.Scan(&idx.Name, &idx.IsPrimary, &idx.IsUnique, &colsCSV); err != nil {
			return nil, err
		}
		idx.Columns = splitCSV(colsCSV)
		out = append(out, idx)
	}
	return out, rows.Err()
}

func splitCSV(s string) []string {
	if s == "" {
		return nil
	}
	out := []string{}
	start := 0
	for i := 0; i < len(s); i++ {
		if s[i] == ',' {
			out = append(out, s[start:i])
			start = i + 1
		}
	}
	out = append(out, s[start:])
	return out
}
