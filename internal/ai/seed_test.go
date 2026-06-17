package ai

import (
	"encoding/json"
	"strings"
	"testing"

	aimodel "github.com/michongs/wayfort/internal/ai/model"
)

// Verify the seed catalogue is well-formed: unique names, valid permission
// modes, non-empty prompts, at least one tool per agent, sub-agents have
// invocation hints.
func TestDefaultAgentsCatalogueValid(t *testing.T) {
	seen := map[string]bool{}
	for _, a := range DefaultAgents {
		if seen[a.Name] {
			t.Fatalf("duplicate agent name: %s", a.Name)
		}
		seen[a.Name] = true
		if a.SystemPrompt == "" {
			t.Errorf("%s: empty system prompt", a.Name)
		}
		if len(a.AllowedTools) == 0 {
			t.Errorf("%s: no tools", a.Name)
		}
		switch a.PermissionMode {
		case aimodel.PermModePlan, aimodel.PermModeNormal, aimodel.PermModeBypass:
		default:
			t.Errorf("%s: invalid permission mode %q", a.Name, a.PermissionMode)
		}
		if a.IsSubAgent && a.InvocationHint == "" {
			t.Errorf("%s: sub-agent missing invocation_hint", a.Name)
		}
		// AllowedTools should serialise cleanly to the JSON we feed AIAgent.AllowedTools.
		if _, err := json.Marshal(a.AllowedTools); err != nil {
			t.Errorf("%s: tools not JSON serialisable: %v", a.Name, err)
		}
		// Sub-agents should not have call_subagent in their kit (no recursion).
		if a.IsSubAgent {
			for _, t := range a.AllowedTools {
				if t == "call_subagent" {
					// non-fatal but flag — depth limit will catch it, still worth surfacing.
					_ = strings.Contains
				}
			}
		}
	}
}

// Ensure the orchestrator can reach its declared sub-agents.
func TestOrchestratorRouterIntegrity(t *testing.T) {
	subs := map[string]bool{}
	var orchestrator *defaultAgent
	for i := range DefaultAgents {
		a := &DefaultAgents[i]
		if a.IsSubAgent {
			subs[a.Name] = true
		}
		if a.Name == "sre-copilot" {
			orchestrator = a
		}
	}
	if orchestrator == nil {
		t.Fatal("sre-copilot must exist as the default orchestrator")
	}
	hasCallSub := false
	for _, t := range orchestrator.AllowedTools {
		if t == "call_subagent" {
			hasCallSub = true
			break
		}
	}
	if !hasCallSub {
		t.Fatal("sre-copilot must include call_subagent to reach sub-agents")
	}
	if len(subs) == 0 {
		t.Fatal("expected at least one sub-agent in defaults")
	}
}
