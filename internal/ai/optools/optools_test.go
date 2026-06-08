package optools

import (
	"encoding/json"
	"strings"
	"testing"

	"github.com/michongs/jumpserver-anonymous/internal/ai/tools"
)

func TestObjSchemaValidJSON(t *testing.T) {
	s := objSchema(nodeIDProp+`,"pid":{"type":"integer"}`, "node_id", "pid")
	var m map[string]any
	if err := json.Unmarshal(s, &m); err != nil {
		t.Fatalf("objSchema produced invalid JSON: %v\n%s", err, s)
	}
	if m["type"] != "object" {
		t.Errorf("expected type object, got %v", m["type"])
	}
	req, ok := m["required"].([]any)
	if !ok || len(req) != 2 {
		t.Errorf("expected 2 required fields, got %v", m["required"])
	}
}

func TestViewEnvelope(t *testing.T) {
	out, err := view("process", map[string]any{"processes": []any{}})
	if err != nil {
		t.Fatal(err)
	}
	var env map[string]any
	if err := json.Unmarshal([]byte(out), &env); err != nil {
		t.Fatalf("view envelope not valid JSON: %v", err)
	}
	if env["_view"] != "process" {
		t.Errorf("expected _view=process, got %v", env["_view"])
	}
	if _, ok := env["data"]; !ok {
		t.Errorf("envelope missing data key")
	}
}

func TestFlattenCoercesTypes(t *testing.T) {
	m := flatten(json.RawMessage(`{"node_id":5,"replicas":3,"name":"web","up":true}`))
	if m["node_id"] != "5" {
		t.Errorf("node_id: want 5, got %q", m["node_id"])
	}
	if m["replicas"] != "3" {
		t.Errorf("replicas: want 3, got %q", m["replicas"])
	}
	if m["name"] != "web" {
		t.Errorf("name: want web, got %q", m["name"])
	}
	if m["up"] != "true" {
		t.Errorf("up: want true, got %q", m["up"])
	}
}

func TestK8sSafeArgRejectsInjection(t *testing.T) {
	good := []string{"pods", "kube-system", "my-deploy.v2", "app/web", "key=val", "10"}
	for _, g := range good {
		if err := validArgs(g); err != nil {
			t.Errorf("validArgs(%q) should pass, got %v", g, err)
		}
	}
	bad := []string{"pods;rm -rf /", "$(whoami)", "a b", "a|b", "`id`", "a>b", "a&b"}
	for _, b := range bad {
		if err := validArgs(b); err == nil {
			t.Errorf("validArgs(%q) should be rejected", b)
		}
	}
}

func TestStrArgRequired(t *testing.T) {
	if _, err := strArg(json.RawMessage(`{"container_id":""}`), "container_id"); err == nil {
		t.Error("empty container_id should error")
	}
	v, err := strArg(json.RawMessage(`{"container_id":"abc"}`), "container_id")
	if err != nil || v != "abc" {
		t.Errorf("want abc, got %q err=%v", v, err)
	}
}

func TestWriteDryRunMentionsArgs(t *testing.T) {
	fn := writeDryRun("重启服务")
	out, _ := fn(nil, tools.ToolCtx{}, json.RawMessage(`{"unit":"nginx"}`))
	if !strings.Contains(out, "重启服务") || !strings.Contains(out, "nginx") {
		t.Errorf("dry-run preview should mention action and args, got %q", out)
	}
}
