package completion

import (
	"context"
	"database/sql"
	"time"
)

type damengProvider struct {
	db *sql.DB
}

// NewDameng targets DM8 / Dameng (Oracle-flavored). Pulls metadata from
// SYS.ALL_USERS / SYS.ALL_OBJECTS / SYS.ALL_TAB_COLUMNS.
func NewDameng(db *sql.DB) Provider {
	return &damengProvider{db: db}
}

func (p *damengProvider) Snapshot(ctx context.Context, database string) (Snapshot, error) {
	if p == nil || p.db == nil {
		return Snapshot{}, errNoDB
	}
	snap := Snapshot{Database: database, UpdatedAt: time.Now().Unix()}

	rows, err := p.db.QueryContext(ctx, `
		SELECT USERNAME FROM SYS.ALL_USERS
		WHERE USERNAME NOT IN ('SYS','SYSTEM','CTISYS','SYSDBA','SYSAUDITOR','SYSSSO')
		ORDER BY USERNAME`)
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

	tableIdx := map[string]int{}
	rows, err = p.db.QueryContext(ctx, `
		SELECT OWNER, OBJECT_NAME, OBJECT_TYPE FROM SYS.ALL_OBJECTS
		WHERE OBJECT_TYPE IN ('TABLE','VIEW')
		  AND OWNER NOT IN ('SYS','SYSTEM','CTISYS','SYSDBA','SYSAUDITOR','SYSSSO')
		ORDER BY OWNER, OBJECT_NAME`)
	if err != nil {
		return snap, err
	}
	for rows.Next() {
		var owner, name, otype string
		if err := rows.Scan(&owner, &name, &otype); err != nil {
			rows.Close()
			return snap, err
		}
		kind := "table"
		if otype == "VIEW" {
			kind = "view"
		}
		snap.Tables = append(snap.Tables, TableEntry{Schema: owner, Name: name, Kind: kind})
		tableIdx[owner+"."+name] = len(snap.Tables) - 1
	}
	rows.Close()

	rows, err = p.db.QueryContext(ctx, `
		SELECT OWNER, TABLE_NAME, COLUMN_NAME, DATA_TYPE, NULLABLE FROM SYS.ALL_TAB_COLUMNS
		WHERE OWNER NOT IN ('SYS','SYSTEM','CTISYS','SYSDBA','SYSAUDITOR','SYSSSO')
		ORDER BY OWNER, TABLE_NAME, COLUMN_ID`)
	if err != nil {
		return snap, err
	}
	for rows.Next() {
		var owner, table, col, dt, nullable string
		if err := rows.Scan(&owner, &table, &col, &dt, &nullable); err != nil {
			rows.Close()
			return snap, err
		}
		if idx, ok := tableIdx[owner+"."+table]; ok {
			snap.Tables[idx].Columns = append(snap.Tables[idx].Columns, ColumnEntry{
				Name: col, DataType: dt, Nullable: nullable == "Y",
			})
		}
	}
	rows.Close()

	rows, err = p.db.QueryContext(ctx, `
		SELECT OWNER, OBJECT_NAME FROM SYS.ALL_OBJECTS WHERE OBJECT_TYPE='FUNCTION'
		  AND OWNER NOT IN ('SYS','SYSTEM','CTISYS','SYSDBA','SYSAUDITOR','SYSSSO')
		ORDER BY OWNER, OBJECT_NAME`)
	if err != nil {
		return snap, err
	}
	for rows.Next() {
		var owner, name string
		if err := rows.Scan(&owner, &name); err != nil {
			rows.Close()
			return snap, err
		}
		snap.Functions = append(snap.Functions, FunctionEntry{
			Schema: owner, Name: name, ArgTypes: nil, ReturnType: "",
		})
	}
	rows.Close()

	return snap, nil
}

func (p *damengProvider) Keywords(ctx context.Context) []string {
	return Keywords("oracle")
}
