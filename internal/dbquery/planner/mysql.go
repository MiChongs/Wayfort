package planner

import (
	"context"
	"database/sql"
	"regexp"
	"strconv"
	"strings"
)

type mysqlPlanner struct{ db *sql.DB }

// NewMySQL builds a planner.Planner that combines EXPLAIN FORMAT=TREE (for
// the tree shape) with EXPLAIN FORMAT=JSON (for the raw payload). The tree
// is parsed via indentation depth.
func NewMySQL(db *sql.DB) Planner {
	return &mysqlPlanner{db: db}
}

var treeLineRe = regexp.MustCompile(`^(\s*)->\s*(.+?)(?:\s+\((.*)\))?$`)

func (p *mysqlPlanner) Plan(ctx context.Context, sqlText string) (*PlanNode, string, error) {
	if p == nil || p.db == nil {
		return nil, "", errNoDB
	}

	// 1) FORMAT=TREE for the tree
	var tree string
	if err := p.db.QueryRowContext(ctx, "EXPLAIN FORMAT=TREE "+sqlText).Scan(&tree); err != nil {
		return nil, "", err
	}
	root := parseTree(tree)

	// 2) FORMAT=JSON for raw textual fallback
	var raw string
	if err := p.db.QueryRowContext(ctx, "EXPLAIN FORMAT=JSON "+sqlText).Scan(&raw); err != nil {
		// JSON failure is non-fatal; tree alone is useful.
		raw = tree
	}
	return root, raw, nil
}

func parseTree(tree string) *PlanNode {
	lines := strings.Split(strings.TrimRight(tree, "\n"), "\n")
	if len(lines) == 0 {
		return nil
	}
	type frame struct {
		node   *PlanNode
		indent int
	}
	var root *PlanNode
	stack := []frame{}
	for _, line := range lines {
		m := treeLineRe.FindStringSubmatch(line)
		if m == nil {
			continue
		}
		indent := len(m[1])
		op := strings.TrimSpace(m[2])
		attrs := parseAttrs(m[3])
		n := &PlanNode{Op: op, Attrs: attrs}
		if v, ok := attrs["cost"]; ok {
			if f, err := strconv.ParseFloat(v, 64); err == nil {
				n.Cost = f
			}
		}
		if v, ok := attrs["rows"]; ok {
			if i, err := strconv.ParseInt(v, 10, 64); err == nil {
				n.Rows = i
			}
		}
		// pop stack until indent decreases
		for len(stack) > 0 && stack[len(stack)-1].indent >= indent {
			stack = stack[:len(stack)-1]
		}
		if len(stack) == 0 {
			root = n
		} else {
			stack[len(stack)-1].node.Children = append(stack[len(stack)-1].node.Children, n)
		}
		stack = append(stack, frame{n, indent})
	}
	return root
}

func parseAttrs(s string) map[string]string {
	out := map[string]string{}
	if s == "" {
		return out
	}
	for _, kv := range strings.Fields(s) {
		eq := strings.IndexByte(kv, '=')
		if eq <= 0 {
			continue
		}
		out[kv[:eq]] = strings.Trim(kv[eq+1:], ",")
	}
	return out
}
