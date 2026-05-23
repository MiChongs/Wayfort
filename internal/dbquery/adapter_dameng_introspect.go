package dbquery

import (
	"context"
	"fmt"
	"strings"
)

// 达梦 DM8 introspection — driven by Oracle-shaped catalog views.
//
// Naming convention: every function reads exclusively from SYS.* /
// SYSOBJECTS / V$ system tables, mirroring Oracle's data dictionary.
// We keep them in one file so the family dispatchers (schema.go /
// processes.go / structure.go / crud.go) stay short and each can do:
//
//   case FamilyOracle:
//       return loadDamengXxx(ctx, pl, ...)
//
// without per-call branching on protocol id.

// ----- schema tree ----------------------------------------------------------

func listDamengDatabases(ctx context.Context, pl *pool) ([]string, error) {
	// DM connects to a single database; "databases" map to schemas
	// (== users). SYS.DBA_USERS lists every schema operators can
	// browse; the connecting user only sees what its CREATE_USER
	// privilege grants visibility to.
	rows, err := pl.db.QueryContext(ctx, `
		SELECT USERNAME
		FROM SYS.DBA_USERS
		WHERE ACCOUNT_STATUS = 'OPEN'
		  AND USERNAME NOT IN ('SYS','SYSDBA','SYSAUDITOR','SYSSSO')
		ORDER BY USERNAME`)
	if err != nil {
		return nil, fmt.Errorf("dameng list users: %w", err)
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

func loadDamengSchema(ctx context.Context, pl *pool) (*SchemaInfo, error) {
	var current string
	if err := pl.db.QueryRowContext(ctx, "SELECT SYS_CONTEXT('USERENV','CURRENT_SCHEMA') FROM DUAL").Scan(&current); err != nil {
		// DM 8.1+ exposes SYS_CONTEXT; older builds use USER. Fall back
		// to USER rather than failing the whole tree fetch.
		_ = pl.db.QueryRowContext(ctx, "SELECT USER FROM DUAL").Scan(&current)
	}
	rows, err := pl.db.QueryContext(ctx, `
		SELECT OWNER, OBJECT_NAME,
		       CASE OBJECT_TYPE
		            WHEN 'TABLE'        THEN 'table'
		            WHEN 'VIEW'         THEN 'view'
		            WHEN 'MATERIALIZED VIEW' THEN 'matview'
		            WHEN 'SEQUENCE'     THEN 'sequence'
		            WHEN 'FUNCTION'     THEN 'function'
		            WHEN 'PROCEDURE'    THEN 'procedure'
		            ELSE LOWER(OBJECT_TYPE) END
		FROM SYS.ALL_OBJECTS
		WHERE OBJECT_TYPE IN ('TABLE','VIEW','MATERIALIZED VIEW','SEQUENCE','FUNCTION','PROCEDURE')
		  AND OWNER NOT IN ('SYS','SYSDBA','SYSAUDITOR','SYSSSO','CTISYS')
		ORDER BY OWNER, OBJECT_TYPE, OBJECT_NAME`)
	if err != nil {
		return nil, fmt.Errorf("dameng list objects: %w", err)
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

func loadDamengColumns(ctx context.Context, pl *pool, schema, table string) ([]ColumnInfo, error) {
	rows, err := pl.db.QueryContext(ctx, `
		SELECT
		  c.COLUMN_NAME,
		  CASE
		    WHEN c.DATA_TYPE LIKE 'CHAR%'  THEN c.DATA_TYPE || '(' || c.DATA_LENGTH || ')'
		    WHEN c.DATA_TYPE LIKE 'VARCHAR%' THEN c.DATA_TYPE || '(' || c.DATA_LENGTH || ')'
		    WHEN c.DATA_TYPE = 'NUMBER' AND c.DATA_PRECISION IS NOT NULL
		         THEN 'NUMBER(' || c.DATA_PRECISION || ',' || NVL(c.DATA_SCALE,0) || ')'
		    ELSE c.DATA_TYPE END AS type_text,
		  CASE c.NULLABLE WHEN 'Y' THEN 1 ELSE 0 END,
		  NVL(c.DATA_DEFAULT, ''),
		  c.COLUMN_ID,
		  CASE WHEN pk.COLUMN_NAME IS NOT NULL THEN 1 ELSE 0 END
		FROM SYS.ALL_TAB_COLUMNS c
		LEFT JOIN (
		  SELECT col.OWNER, col.TABLE_NAME, col.COLUMN_NAME
		  FROM SYS.ALL_CONSTRAINTS con
		  JOIN SYS.ALL_CONS_COLUMNS col
		    ON col.OWNER = con.OWNER AND col.CONSTRAINT_NAME = con.CONSTRAINT_NAME
		  WHERE con.CONSTRAINT_TYPE = 'P'
		) pk
		  ON pk.OWNER = c.OWNER AND pk.TABLE_NAME = c.TABLE_NAME AND pk.COLUMN_NAME = c.COLUMN_NAME
		WHERE c.OWNER = :1 AND c.TABLE_NAME = :2
		ORDER BY c.COLUMN_ID`, schema, table)
	if err != nil {
		return nil, fmt.Errorf("dameng columns: %w", err)
	}
	defer rows.Close()
	out := []ColumnInfo{}
	for rows.Next() {
		var c ColumnInfo
		var nullableI, pkI int
		var def string
		if err := rows.Scan(&c.Name, &c.Type, &nullableI, &def, &c.OrdinalPos, &pkI); err != nil {
			return nil, err
		}
		c.Nullable = nullableI == 1
		c.IsPrimaryKey = pkI == 1
		if def != "" {
			d := def
			c.DefaultValue = &d
		}
		out = append(out, c)
	}
	return out, rows.Err()
}

func loadDamengIndexes(ctx context.Context, pl *pool, schema, table string) ([]IndexInfo, error) {
	rows, err := pl.db.QueryContext(ctx, `
		SELECT i.INDEX_NAME,
		       CASE WHEN c.CONSTRAINT_TYPE = 'P' THEN 1 ELSE 0 END AS is_primary,
		       CASE i.UNIQUENESS WHEN 'UNIQUE' THEN 1 ELSE 0 END AS is_unique,
		       LISTAGG(ic.COLUMN_NAME, ',') WITHIN GROUP (ORDER BY ic.COLUMN_POSITION)
		FROM SYS.ALL_INDEXES i
		JOIN SYS.ALL_IND_COLUMNS ic
		  ON ic.INDEX_OWNER = i.OWNER AND ic.INDEX_NAME = i.INDEX_NAME
		LEFT JOIN SYS.ALL_CONSTRAINTS c
		  ON c.OWNER = i.OWNER AND c.INDEX_NAME = i.INDEX_NAME AND c.CONSTRAINT_TYPE = 'P'
		WHERE i.OWNER = :1 AND i.TABLE_NAME = :2
		GROUP BY i.INDEX_NAME, c.CONSTRAINT_TYPE, i.UNIQUENESS
		ORDER BY is_primary DESC, i.INDEX_NAME`, schema, table)
	if err != nil {
		return nil, fmt.Errorf("dameng indexes: %w", err)
	}
	defer rows.Close()
	out := []IndexInfo{}
	for rows.Next() {
		var name string
		var isPK, isUnique int
		var colsCSV string
		if err := rows.Scan(&name, &isPK, &isUnique, &colsCSV); err != nil {
			return nil, err
		}
		out = append(out, IndexInfo{
			Name:      name,
			IsPrimary: isPK == 1,
			IsUnique:  isUnique == 1,
			Columns:   splitCSV(colsCSV),
		})
	}
	return out, rows.Err()
}

// ----- structure (FKs / stats / DDL) ---------------------------------------

func loadDamengForeignKeys(ctx context.Context, pl *pool, schema, table string) ([]ForeignKeyInfo, error) {
	rows, err := pl.db.QueryContext(ctx, `
		SELECT
		  c.CONSTRAINT_NAME,
		  c.OWNER, c.TABLE_NAME,
		  LISTAGG(cc.COLUMN_NAME, ',') WITHIN GROUP (ORDER BY cc.POSITION),
		  r.OWNER, r.TABLE_NAME,
		  LISTAGG(rc.COLUMN_NAME, ',') WITHIN GROUP (ORDER BY rc.POSITION),
		  NVL(c.DELETE_RULE, 'NO ACTION'),
		  'NO ACTION'   -- DM has no DBA_CONSTRAINTS.UPDATE_RULE column
		FROM SYS.ALL_CONSTRAINTS c
		JOIN SYS.ALL_CONS_COLUMNS cc
		  ON cc.OWNER = c.OWNER AND cc.CONSTRAINT_NAME = c.CONSTRAINT_NAME
		JOIN SYS.ALL_CONSTRAINTS r
		  ON r.OWNER = c.R_OWNER AND r.CONSTRAINT_NAME = c.R_CONSTRAINT_NAME
		JOIN SYS.ALL_CONS_COLUMNS rc
		  ON rc.OWNER = r.OWNER AND rc.CONSTRAINT_NAME = r.CONSTRAINT_NAME AND rc.POSITION = cc.POSITION
		WHERE c.CONSTRAINT_TYPE = 'R'
		  AND ((c.OWNER = :1 AND c.TABLE_NAME = :2)
		    OR (r.OWNER = :1 AND r.TABLE_NAME = :2))
		GROUP BY c.CONSTRAINT_NAME, c.OWNER, c.TABLE_NAME, r.OWNER, r.TABLE_NAME, c.DELETE_RULE
		ORDER BY c.CONSTRAINT_NAME`, schema, table)
	if err != nil {
		return nil, fmt.Errorf("dameng fks: %w", err)
	}
	defer rows.Close()
	out := []ForeignKeyInfo{}
	for rows.Next() {
		var name, fs, ft, fc, ts, tt, tc, onD, onU string
		if err := rows.Scan(&name, &fs, &ft, &fc, &ts, &tt, &tc, &onD, &onU); err != nil {
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

func loadDamengStats(ctx context.Context, pl *pool, schema, table string) (*TableStats, error) {
	row := pl.db.QueryRowContext(ctx, `
		SELECT
		  COALESCE(NUM_ROWS, 0),
		  COALESCE(BLOCKS * 8192, 0) AS total_bytes,
		  COALESCE(BLOCKS * 8192, 0) AS data_bytes,
		  0 AS index_bytes,
		  COALESCE(TABLESPACE_NAME, '')
		FROM SYS.ALL_TABLES
		WHERE OWNER = :1 AND TABLE_NAME = :2`, schema, table)
	st := &TableStats{}
	if err := row.Scan(&st.RowsApprox, &st.TotalBytes, &st.DataBytes, &st.IndexBytes, &st.Engine); err != nil {
		return nil, fmt.Errorf("dameng stats: %w", err)
	}
	return st, nil
}

func loadDamengDDL(ctx context.Context, pl *pool, schema, table string) (string, error) {
	// DM exposes DBMS_METADATA.GET_DDL the same way Oracle does.
	row := pl.db.QueryRowContext(ctx, `
		SELECT DBMS_METADATA.GET_DDL('TABLE', :1, :2) FROM DUAL`, table, schema)
	var ddl string
	if err := row.Scan(&ddl); err != nil {
		return "", fmt.Errorf("dameng ddl: %w", err)
	}
	return ddl + ";\n", nil
}

// ----- processes -----------------------------------------------------------

func listDamengProcesses(ctx context.Context, pl *pool) ([]ProcessInfo, error) {
	rows, err := pl.db.QueryContext(ctx, `
		SELECT
		  SESS_ID, NVL(USER_NAME, ''), NVL(CLNT_IP, ''),
		  NVL(CURR_SCH, ''), NVL(STATE, ''), '',
		  NVL(APPNAME, ''),
		  TO_CHAR(LAST_RECV_TIME, 'YYYY-MM-DD"T"HH24:MI:SS"Z"'),
		  NVL(EXTRACT(EPOCH FROM (SYSDATE - LAST_RECV_TIME)), 0),
		  NVL(SQL_TEXT, '')
		FROM V$SESSIONS
		WHERE SESS_ID <> SYS_CONTEXT('USERENV','SID')
		ORDER BY LAST_RECV_TIME DESC NULLS LAST`)
	if err != nil {
		return nil, fmt.Errorf("dameng processes: %w", err)
	}
	defer rows.Close()
	out := []ProcessInfo{}
	for rows.Next() {
		var p ProcessInfo
		if err := rows.Scan(&p.PID, &p.Username, &p.ClientAddr, &p.Database, &p.State,
			&p.WaitEvent, &p.Application, &p.QueryStart, &p.ElapsedSec, &p.Query); err != nil {
			return nil, err
		}
		out = append(out, p)
	}
	return out, rows.Err()
}

func cancelDamengProcess(ctx context.Context, pl *pool, pid int64) (bool, error) {
	// SP_CLOSE_SESSION cancels the running statement; the session
	// stays alive (mirrors MySQL KILL QUERY). DM also has
	// SP_KILL_SESSION (forced disconnect) which we deliberately don't
	// use here — the UI's "Kill" semantics are statement-level.
	_, err := pl.db.ExecContext(ctx, fmt.Sprintf("SP_CLOSE_SESSION(%d)", pid))
	if err != nil {
		return false, err
	}
	return true, nil
}

// ----- explain --------------------------------------------------------------

func damengExplainSQL(statement string, analyze bool) string {
	// DM supports EXPLAIN (no execute) for any SELECT/DML. ANALYZE
	// equivalent is the system procedure DBMS_STATS.GATHER_PLAN_STATS
	// for whole-plan post-mortem; we surface plain EXPLAIN here and
	// let the operator drop into a SQL terminal for true analyze.
	_ = analyze
	return "EXPLAIN " + statement
}
