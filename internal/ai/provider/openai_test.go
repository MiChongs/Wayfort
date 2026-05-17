package provider

import (
	"strings"
	"testing"
)

// Smoke check that we can construct an OpenAI provider and that compatibility
// gateways differ only in Kind + BaseURL.
func TestOpenAIConstructionSmoke(t *testing.T) {
	p, err := NewOpenAI(OpenAIConfig{
		Name: "openai", APIKey: "sk-test", DefaultModel: "gpt-4o-mini",
	})
	if err != nil {
		t.Fatal(err)
	}
	if p.Kind() != KindOpenAI {
		t.Fatalf("expected openai kind, got %q", p.Kind())
	}
	if p.Name() != "openai" {
		t.Fatal("wrong name")
	}

	compat, err := NewOpenAI(OpenAIConfig{
		Name: "siliconflow", Kind: KindOpenAICompat, APIKey: "sk-test",
		BaseURL: "https://api.siliconflow.cn/v1", DefaultModel: "Qwen/Qwen2.5-72B",
	})
	if err != nil {
		t.Fatal(err)
	}
	if compat.Kind() != KindOpenAICompat {
		t.Fatal("compat kind wrong")
	}
}

func TestCollectTextJoinsParts(t *testing.T) {
	got := collectText([]ContentPart{
		{Type: "text", Text: "hello "},
		{Type: "image_url", ImageURL: "http://example.com/x.png"},
		{Type: "text", Text: "world"},
	})
	if got != "hello world" {
		t.Fatalf("got %q", got)
	}
}

func TestBuildOpenAIToolsFromSchema(t *testing.T) {
	schema := `{"type":"object","properties":{"x":{"type":"integer"}},"required":["x"]}`
	tools := buildOpenAITools([]ToolSchema{
		{Name: "do_x", Description: "do something", JSONSchema: []byte(schema)},
	})
	if len(tools) != 1 {
		t.Fatalf("want 1 tool, got %d", len(tools))
	}
	if tools[0].Function.Name != "do_x" {
		t.Fatal("name wrong")
	}
	if !strings.Contains(string(toolFunctionParams(tools[0].Function.Parameters)), `"x"`) {
		t.Fatal("schema not preserved")
	}
}

func toolFunctionParams(p map[string]any) []byte {
	b, _ := jsonMarshalHelper(p)
	return b
}

func jsonMarshalHelper(v any) ([]byte, error) {
	// re-use std json via the provider's go.mod transitively
	return []byte(stringify(v)), nil
}

func stringify(v any) string {
	switch t := v.(type) {
	case map[string]any:
		var sb strings.Builder
		sb.WriteString("{")
		for k, vv := range t {
			sb.WriteString(`"`)
			sb.WriteString(k)
			sb.WriteString(`":`)
			sb.WriteString(stringify(vv))
			sb.WriteString(",")
		}
		s := sb.String()
		if s[len(s)-1] == ',' {
			s = s[:len(s)-1]
		}
		return s + "}"
	case string:
		return `"` + t + `"`
	default:
		return "null"
	}
}
