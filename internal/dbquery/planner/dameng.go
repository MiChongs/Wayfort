package planner

import (
	"context"
	"database/sql"
)

type damengPlanner struct{ db *sql.DB }

func NewDameng(db *sql.DB) Planner { return &damengPlanner{db: db} }

func (p *damengPlanner) Plan(ctx context.Context, sqlText string) (*PlanNode, string, error) {
	if p == nil || p.db == nil {
		return nil, "", errNoDB
	}
	// DM uses EXPLAIN PLAN FOR ... then queries the PLAN_TABLE.
	if _, err := p.db.ExecContext(ctx, "EXPLAIN PLAN FOR "+sqlText); err != nil {
		return nil, "", err
	}
	rows, err := p.db.QueryContext(ctx, `
		SELECT ID, PARENT_ID, OPERATION, OBJECT_NAME, CARDINALITY, COST
		FROM PLAN_TABLE ORDER BY ID`)
	if err != nil {
		return nil, "", err
	}
	defer rows.Close()
	byID := map[int]*PlanNode{}
	var raw string
	rootID := -1
	for rows.Next() {
		var id, parentID sql.NullInt64
		var op, obj sql.NullString
		var card sql.NullInt64
		var cost sql.NullFloat64
		if err := rows.Scan(&id, &parentID, &op, &obj, &card, &cost); err != nil {
			return nil, raw, err
		}
		n := &PlanNode{
			Op: op.String, Table: obj.String,
			Rows: card.Int64, Cost: cost.Float64,
			Attrs: map[string]string{},
		}
		byID[int(id.Int64)] = n
		if !parentID.Valid {
			rootID = int(id.Int64)
		} else if parent, ok := byID[int(parentID.Int64)]; ok {
			parent.Children = append(parent.Children, n)
		}
	}
	return byID[rootID], raw, nil
}
