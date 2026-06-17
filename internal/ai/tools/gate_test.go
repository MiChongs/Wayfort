package tools

import (
	"context"
	"encoding/json"
	"testing"

	aimodel "github.com/michongs/wayfort/internal/ai/model"
)

func dummyTool(name string, danger Danger) *Tool {
	return &Tool{Name: name, Danger: danger, Schema: json.RawMessage(`{}`)}
}

func TestGatePlanModeDryRunsHighDanger(t *testing.T) {
	g := &PermissionGate{Mode: aimodel.PermModePlan}
	dec, _, err := g.Authorize(context.Background(), dummyTool("ssh_exec", DangerHigh), json.RawMessage(`{}`), 1)
	if err != nil {
		t.Fatal(err)
	}
	if dec != DecisionDryRun {
		t.Fatalf("plan/high should dry-run, got %v", dec)
	}
}

func TestGatePlanModeAllowsLowDanger(t *testing.T) {
	g := &PermissionGate{Mode: aimodel.PermModePlan}
	dec, _, _ := g.Authorize(context.Background(), dummyTool("list_nodes", DangerLow), json.RawMessage(`{}`), 1)
	if dec != DecisionRun {
		t.Fatalf("plan/low should run, got %v", dec)
	}
}

func TestGateNormalRequiresApproval(t *testing.T) {
	g := &PermissionGate{Mode: aimodel.PermModeNormal}
	dec, _, _ := g.Authorize(context.Background(), dummyTool("ssh_exec", DangerHigh), json.RawMessage(`{}`), 1)
	if dec != DecisionApprove {
		t.Fatalf("normal/high should ask approval, got %v", dec)
	}
}

func TestGateBypassRunsEverything(t *testing.T) {
	g := &PermissionGate{Mode: aimodel.PermModeBypass}
	dec, _, _ := g.Authorize(context.Background(), dummyTool("ssh_exec", DangerHigh), json.RawMessage(`{}`), 1)
	if dec != DecisionRun {
		t.Fatalf("bypass/high should run, got %v", dec)
	}
}

func TestRegistryProviderSchemas(t *testing.T) {
	r := NewRegistry()
	r.Register(&Tool{Name: "a", Description: "A", Schema: json.RawMessage(`{}`)})
	r.Register(&Tool{Name: "b", Description: "B", Schema: json.RawMessage(`{}`)})
	out := r.ProviderSchemas([]string{"a"})
	if len(out) != 1 || out[0].Name != "a" {
		t.Fatalf("filter wrong: %+v", out)
	}
}
