package completion

import (
	"context"
	"database/sql"
	"time"
)

type mysqlProvider struct {
	db *sql.DB
}

// NewMySQL builds a completion.Provider backed by information_schema queries.
// The caller owns *sql.DB lifecycle — the provider only reads.
func NewMySQL(db *sql.DB) Provider {
	return &mysqlProvider{db: db}
}

func (p *mysqlProvider) Snapshot(ctx context.Context, database string) (Snapshot, error) {
	if p == nil || p.db == nil {
		return Snapshot{}, errNoDB
	}

	snap := Snapshot{
		Database:  database,
		UpdatedAt: time.Now().Unix(),
	}

	// 1. schemas — every queryable database except internal ones
	rows, err := p.db.QueryContext(ctx, `
		SELECT schema_name FROM information_schema.schemata
		WHERE schema_name NOT IN ('information_schema','performance_schema','mysql','sys')
		ORDER BY schema_name`)
	if err != nil {
		return snap, err
	}
	for rows.Next() {
		var s string
		if err := rows.Scan(&s); err != nil {
			rows.Close()
			return snap, err
		}
		snap.Schemas = append(snap.Schemas, s)
	}
	rows.Close()

	// 2. tables + views
	tableIdx := map[string]int{} // fqn → index in snap.Tables
	rows, err = p.db.QueryContext(ctx, `
		SELECT table_schema, table_name, table_type
		FROM information_schema.tables
		WHERE table_schema NOT IN ('information_schema','performance_schema','mysql','sys')
		ORDER BY table_schema, table_name`)
	if err != nil {
		return snap, err
	}
	for rows.Next() {
		var schema, name, ttype string
		if err := rows.Scan(&schema, &name, &ttype); err != nil {
			rows.Close()
			return snap, err
		}
		kind := "table"
		if ttype == "VIEW" {
			kind = "view"
		}
		entry := TableEntry{Schema: schema, Name: name, Kind: kind}
		snap.Tables = append(snap.Tables, entry)
		tableIdx[schema+"."+name] = len(snap.Tables) - 1
	}
	rows.Close()

	// 3. columns
	rows, err = p.db.QueryContext(ctx, `
		SELECT table_schema, table_name, column_name, data_type, is_nullable
		FROM information_schema.columns
		WHERE table_schema NOT IN ('information_schema','performance_schema','mysql','sys')
		ORDER BY table_schema, table_name, ordinal_position`)
	if err != nil {
		return snap, err
	}
	for rows.Next() {
		var schema, name, col, dt, nullable string
		if err := rows.Scan(&schema, &name, &col, &dt, &nullable); err != nil {
			rows.Close()
			return snap, err
		}
		if idx, ok := tableIdx[schema+"."+name]; ok {
			snap.Tables[idx].Columns = append(snap.Tables[idx].Columns, ColumnEntry{
				Name: col, DataType: dt, Nullable: nullable == "YES",
			})
		}
	}
	rows.Close()

	// 4. functions
	rows, err = p.db.QueryContext(ctx, `
		SELECT routine_schema, routine_name, data_type
		FROM information_schema.routines
		WHERE routine_type='FUNCTION'
		  AND routine_schema NOT IN ('information_schema','performance_schema','mysql','sys')
		ORDER BY routine_schema, routine_name`)
	if err != nil {
		return snap, err
	}
	for rows.Next() {
		var schema, name, ret string
		if err := rows.Scan(&schema, &name, &ret); err != nil {
			rows.Close()
			return snap, err
		}
		snap.Functions = append(snap.Functions, FunctionEntry{
			Schema: schema, Name: name, ArgTypes: nil, ReturnType: ret,
		})
	}
	rows.Close()

	return snap, nil
}

func (p *mysqlProvider) Keywords(ctx context.Context) []string {
	return Keywords("mysql")
}
