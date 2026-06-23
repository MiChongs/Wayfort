// Package planner defines the execution-plan parser contract.
package planner

import "context"

// Planner parses an engine's EXPLAIN output into a normalised PlanNode
// tree the UI can render uniformly.
type Planner interface {
	// Plan asks the engine for an execution plan of sql and returns
	// the root node and a textual fallback (engine-specific format).
	Plan(ctx context.Context, sql string) (root *PlanNode, raw string, err error)
}

// PlanNode is a single operator in an execution plan.
type PlanNode struct {
	Op         string            // SeqScan, HashJoin, NestLoop, ...
	Table      string            // affected table (if any)
	Rows       int64             // estimated rows
	Cost       float64           // engine cost; relative scale
	Width      int64             // bytes per row (PG)
	ActualRows int64             // ANALYZE only; -1 = unavailable
	ActualMs   float64           // ANALYZE only; -1 = unavailable
	Warnings   []string          // optimiser warnings
	Attrs      map[string]string // engine-specific extras
	Children   []*PlanNode
}
