package planner

import "testing"

func TestPlanNodeChildren(t *testing.T) {
	n := &PlanNode{Op: "SeqScan", Children: []*PlanNode{{Op: "Filter"}}}
	if len(n.Children) != 1 || n.Children[0].Op != "Filter" {
		t.Fatal("children wiring broken")
	}
}
