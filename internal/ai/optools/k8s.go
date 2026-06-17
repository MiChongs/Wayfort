package optools

import (
	"context"
	"encoding/json"
	"fmt"
	"regexp"
	"strconv"
	"strings"

	"github.com/michongs/wayfort/internal/ai/tools"
	"github.com/michongs/wayfort/internal/asset"
)

// flatten decodes the tool args into a flat string map, coercing numbers/bools
// so callers can treat every field uniformly (the JSON schema mixes integer
// node_id/replicas with string fields).
func flatten(raw json.RawMessage) map[string]string {
	var m map[string]any
	_ = json.Unmarshal(raw, &m)
	out := make(map[string]string, len(m))
	for k, v := range m {
		switch t := v.(type) {
		case string:
			out[k] = t
		case float64:
			if t == float64(int64(t)) {
				out[k] = strconv.FormatInt(int64(t), 10)
			} else {
				out[k] = strconv.FormatFloat(t, 'f', -1, 64)
			}
		case bool:
			out[k] = strconv.FormatBool(t)
		case nil:
			// skip
		default:
			out[k] = fmt.Sprint(t)
		}
	}
	return out
}

// k8s tools shell out to kubectl on the node via the SSH bridge. Every argument
// that reaches the command line is validated against a strict whitelist so the
// model can never inject shell metacharacters; nothing is passed unquoted that
// hasn't matched safeArg.
var safeArg = regexp.MustCompile(`^[A-Za-z0-9._/:=-]+$`)

func validArgs(vals ...string) error {
	for _, v := range vals {
		if v == "" {
			continue
		}
		if !safeArg.MatchString(v) {
			return fmt.Errorf("非法参数 %q（仅允许字母数字与 . _ / : = -）", v)
		}
	}
	return nil
}

func registerK8sTools(reg *tools.Registry, deps Deps) {
	if deps.NodeRunner == nil {
		return
	}

	k8sRead := func(name, desc, schema string, build func(a map[string]string) ([]string, error)) {
		reg.Register(&tools.Tool{
			Name:                name,
			Description:         desc,
			Danger:              tools.DangerLow,
			RequiredAssetAction: asset.ActionConnect,
			Schema:              objSchema(schema, "node_id"),
			Run: func(ctx context.Context, t tools.ToolCtx, raw json.RawMessage) (string, error) {
				nid, err := parseNodeID(raw)
				if err != nil {
					return "", err
				}
				args, err := build(flatten(raw))
				if err != nil {
					return "", err
				}
				return runKubectl(ctx, deps, t, nid, args)
			},
		})
	}

	k8sRead("k8s_get",
		"kubectl get：列出某类资源(pods/deploy/svc/nodes...)。",
		nodeIDProp+`,"resource":{"type":"string","description":"资源类型，如 pods/deployments/nodes"},"namespace":{"type":"string","description":"命名空间，可空"},"name":{"type":"string","description":"资源名，可空"}`,
		func(a map[string]string) ([]string, error) {
			res, ns, name := a["resource"], a["namespace"], a["name"]
			if res == "" {
				return nil, fmt.Errorf("resource required")
			}
			if err := validArgs(res, ns, name); err != nil {
				return nil, err
			}
			args := []string{"get", res}
			if name != "" {
				args = append(args, name)
			}
			args = append(args, nsArgs(ns)...)
			return append(args, "-o", "wide"), nil
		})

	k8sRead("k8s_describe",
		"kubectl describe：查看某个资源的详细描述与事件。",
		nodeIDProp+`,"resource":{"type":"string"},"name":{"type":"string"},"namespace":{"type":"string"}`,
		func(a map[string]string) ([]string, error) {
			res, name, ns := a["resource"], a["name"], a["namespace"]
			if res == "" || name == "" {
				return nil, fmt.Errorf("resource and name required")
			}
			if err := validArgs(res, name, ns); err != nil {
				return nil, err
			}
			return append([]string{"describe", res, name}, nsArgs(ns)...), nil
		})

	k8sRead("k8s_logs",
		"kubectl logs：读取某个 Pod(容器)的日志。",
		nodeIDProp+`,"pod":{"type":"string"},"namespace":{"type":"string"},"container":{"type":"string","description":"容器名，可空"},"tail":{"type":"string","description":"末尾行数，可空"}`,
		func(a map[string]string) ([]string, error) {
			pod, ns, c, tail := a["pod"], a["namespace"], a["container"], a["tail"]
			if pod == "" {
				return nil, fmt.Errorf("pod required")
			}
			if err := validArgs(pod, ns, c, tail); err != nil {
				return nil, err
			}
			args := append([]string{"logs", pod}, nsArgs(ns)...)
			if c != "" {
				args = append(args, "-c", c)
			}
			if tail == "" {
				tail = "200"
			}
			return append(args, "--tail="+tail), nil
		})

	k8sRead("k8s_top",
		"kubectl top：查看节点或 Pod 的资源用量。",
		nodeIDProp+`,"kind":{"type":"string","enum":["nodes","pods"]},"namespace":{"type":"string"}`,
		func(a map[string]string) ([]string, error) {
			kind, ns := a["kind"], a["namespace"]
			if kind != "nodes" && kind != "pods" {
				return nil, fmt.Errorf("kind must be nodes or pods")
			}
			if err := validArgs(ns); err != nil {
				return nil, err
			}
			return append([]string{"top", kind}, nsArgs(ns)...), nil
		})

	// ----- write (high danger, approval) -----
	k8sWrite := func(name, desc, dryAction, schema string, required []string, build func(a map[string]string) ([]string, error)) {
		reg.Register(&tools.Tool{
			Name:                name,
			Description:         desc,
			Danger:              tools.DangerHigh,
			RequiredAssetAction: asset.ActionConnect,
			Schema:              objSchema(schema, append([]string{"node_id"}, required...)...),
			Run: func(ctx context.Context, t tools.ToolCtx, raw json.RawMessage) (string, error) {
				nid, err := parseNodeID(raw)
				if err != nil {
					return "", err
				}
				args, err := build(flatten(raw))
				if err != nil {
					return "", err
				}
				return runKubectl(ctx, deps, t, nid, args)
			},
			DryRun: writeDryRun(dryAction),
		})
	}

	k8sWrite("k8s_scale",
		"kubectl scale：调整 Deployment 副本数。高危操作，需审批。",
		"调整 Deployment 副本数",
		nodeIDProp+`,"deployment":{"type":"string"},"replicas":{"type":"integer","minimum":0,"maximum":1000},"namespace":{"type":"string"}`,
		[]string{"deployment", "replicas"},
		func(a map[string]string) ([]string, error) {
			dep, ns, replicas := a["deployment"], a["namespace"], a["replicas"]
			if dep == "" || replicas == "" {
				return nil, fmt.Errorf("deployment and replicas required")
			}
			if err := validArgs(dep, ns, replicas); err != nil {
				return nil, err
			}
			return append([]string{"scale", "deployment/" + dep, "--replicas=" + replicas}, nsArgs(ns)...), nil
		})

	k8sWrite("k8s_delete",
		"kubectl delete：删除某个资源。高危操作，需审批。",
		"删除 Kubernetes 资源",
		nodeIDProp+`,"resource":{"type":"string"},"name":{"type":"string"},"namespace":{"type":"string"}`,
		[]string{"resource", "name"},
		func(a map[string]string) ([]string, error) {
			res, name, ns := a["resource"], a["name"], a["namespace"]
			if res == "" || name == "" {
				return nil, fmt.Errorf("resource and name required")
			}
			if err := validArgs(res, name, ns); err != nil {
				return nil, err
			}
			return append([]string{"delete", res, name}, nsArgs(ns)...), nil
		})
}

func nsArgs(ns string) []string {
	if ns == "" {
		return nil
	}
	return []string{"-n", ns}
}

func runKubectl(ctx context.Context, deps Deps, t tools.ToolCtx, nid uint64, args []string) (string, error) {
	cmd := "kubectl " + strings.Join(args, " ")
	stdout, stderr, exit, err := deps.NodeRunner.Exec(ctx, t.UserID, nid, cmd, 60)
	if err != nil {
		return "", err
	}
	merged := stdout
	if strings.TrimSpace(stderr) != "" {
		merged += "\n[stderr]\n" + stderr
	}
	body, _ := tools.Truncate(merged)
	return body + fmt.Sprintf("\n[exit=%d]", exit), nil
}
