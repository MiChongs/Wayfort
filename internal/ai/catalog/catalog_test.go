package catalog

import (
	"testing"

	aimodel "github.com/michongs/wayfort/internal/ai/model"
)

func validKind(k aimodel.ProviderKind) bool {
	switch k {
	case aimodel.ProviderOpenAI, aimodel.ProviderAnthropic,
		aimodel.ProviderOpenAICompat, aimodel.ProviderGemini:
		return true
	}
	return false
}

func TestPresetsWellFormed(t *testing.T) {
	seen := map[string]bool{}
	for _, p := range All() {
		if p.ID == "" || p.DisplayName == "" {
			t.Errorf("preset with empty id/name: %+v", p)
		}
		if seen[p.ID] {
			t.Errorf("duplicate preset id %q", p.ID)
		}
		seen[p.ID] = true
		if !validKind(p.Kind) {
			t.Errorf("preset %q has invalid kind %q", p.ID, p.Kind)
		}
		// Non-local, non-azure/bedrock presets should carry a base URL or be the
		// first-party kinds (openai/anthropic/gemini) which have built-in defaults.
		if p.Region == RegionDomestic && p.BaseURL == "" {
			t.Errorf("domestic preset %q missing base_url", p.ID)
		}
		// Curated models must have unique ids within the preset.
		mseen := map[string]bool{}
		for _, m := range p.Models {
			if m.ID == "" {
				t.Errorf("preset %q has a model with empty id", p.ID)
			}
			if mseen[m.ID] {
				t.Errorf("preset %q duplicate model %q", p.ID, m.ID)
			}
			mseen[m.ID] = true
		}
	}
}

func TestByIDAndModelByID(t *testing.T) {
	if _, ok := ByID("does-not-exist"); ok {
		t.Fatal("ByID returned ok for unknown id")
	}
	p, ok := ByID("anthropic")
	if !ok {
		t.Fatal("expected anthropic preset")
	}
	if len(p.Models) == 0 {
		t.Fatal("anthropic preset has no models")
	}
	first := p.Models[0].ID
	if m, ok := ModelByID("anthropic", first); !ok || m.ID != first {
		t.Fatalf("ModelByID round-trip failed for %q", first)
	}
	if _, ok := ModelByID("anthropic", "nope"); ok {
		t.Fatal("ModelByID returned ok for unknown model")
	}
}

func TestModelByKindAndID(t *testing.T) {
	if _, ok := ModelByKindAndID(aimodel.ProviderAnthropic, "claude-opus-4-8"); !ok {
		t.Fatal("expected to find claude-opus-4-8 under anthropic kind")
	}
	if _, ok := ModelByKindAndID(aimodel.ProviderGemini, "claude-opus-4-8"); ok {
		t.Fatal("claude model should not resolve under gemini kind")
	}
}

func TestRegionsOrdered(t *testing.T) {
	rs := Regions()
	if len(rs) == 0 {
		t.Fatal("no regions")
	}
	if rs[0] != RegionInternational {
		t.Fatalf("expected international first, got %q", rs[0])
	}
}
