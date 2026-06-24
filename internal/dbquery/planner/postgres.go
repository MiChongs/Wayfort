package planner

import (
	"context"
	"database/sql"
	"encoding/json"
)

type postgresPlanner struct{ db *sql.DB }

func NewPostgres(db *sql.DB) Planner { return &postgresPlanner{db: db} }

type pgPlan struct {
	NodeType     string         `json:"Node Type"`
	RelationName string         `json:"Relation Name,omitempty"`
	StartupCost  float64        `json:"Startup Cost"`
	TotalCost    float64        `json:"Total Cost"`
	PlanRows     int64          `json:"Plan Rows"`
	PlanWidth    int64          `json:"Plan Width"`
	Plans        []pgPlan       `json:"Plans,omitempty"`
	Other        map[string]any `json:"-"`
}

func (p *postgresPlanner) Plan(ctx context.Context, sqlText string) (*PlanNode, string, error) {
	if p == nil || p.db == nil {
		return nil, "", errNoDB
	}
	var raw string
	if err := p.db.QueryRowContext(ctx, "EXPLAIN (FORMAT JSON) "+sqlText).Scan(&raw); err != nil {
		return nil, "", err
	}
	var outer []struct {
		Plan pgPlan `json:"Plan"`
	}
	if err := json.Unmarshal([]byte(raw), &outer); err != nil {
		return nil, raw, err
	}
	if len(outer) == 0 {
		return nil, raw, nil
	}
	return pgToNode(outer[0].Plan), raw, nil
}

func pgToNode(p pgPlan) *PlanNode {
	n := &PlanNode{
		Op: p.NodeType, Table: p.RelationName,
		Rows: p.PlanRows, Cost: p.TotalCost, Width: p.PlanWidth,
		Attrs: map[string]string{},
	}
	for _, c := range p.Plans {
		n.Children = append(n.Children, pgToNode(c))
	}
	return n
}
