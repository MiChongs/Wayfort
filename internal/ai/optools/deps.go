// Package optools registers the "operations" tool families for the AI agent.
//
// Unlike internal/ai/tools (which stays light and only depends on small local
// interfaces), this package deliberately imports the heavy ops subsystems
// (process, systemd, docker, dbquery, oss, …) and wraps their already-built
// Manager / Service methods as agent-callable tools. None of those packages
// import internal/ai, so there is no import cycle; the coupling is isolated
// here and wired from main.go after ai.New() returns.
//
// Result convention: read tools return a JSON envelope {"_view":"<family>",
// "data":<payload>} so the web UI can pick a humanised renderer; write tools
// return a short human-readable confirmation string. Every write tool is
// Danger=high (gate → approval in normal mode, dry-run in plan mode) and
// carries the same RBAC perm code the REST route uses, plus RequiredAssetAction
// "connect" so the gate verifies node access before running.
package optools

import (
	"context"
	"encoding/json"
	"fmt"
	"strings"

	"github.com/michongs/wayfort/internal/ai/knowledge"
	"github.com/michongs/wayfort/internal/ai/tools"
	"github.com/michongs/wayfort/internal/asset"
	"github.com/michongs/wayfort/internal/audit"
	"github.com/michongs/wayfort/internal/auth"
	"github.com/michongs/wayfort/internal/cron"
	"github.com/michongs/wayfort/internal/dbquery"
	"github.com/michongs/wayfort/internal/docker"
	"github.com/michongs/wayfort/internal/firewall"
	"github.com/michongs/wayfort/internal/hardware"
	"github.com/michongs/wayfort/internal/kernel"
	"github.com/michongs/wayfort/internal/logs"
	"github.com/michongs/wayfort/internal/nettools"
	"github.com/michongs/wayfort/internal/perf"
	"github.com/michongs/wayfort/internal/pkg"
	"github.com/michongs/wayfort/internal/process"
	"github.com/michongs/wayfort/internal/protocols/oss"
	"github.com/michongs/wayfort/internal/secaudit"
	"github.com/michongs/wayfort/internal/storage"
	"github.com/michongs/wayfort/internal/sysuser"
	"github.com/michongs/wayfort/internal/systemd"
	"go.uber.org/zap"
)

// aiClientIP marks audit rows that an action was performed by the AI agent on
// the user's behalf (there is no real client IP in the agentic loop).
const aiClientIP = "ai-agent"

// Deps bundles every ops subsystem the tool families need. All fields are
// optional: a nil Manager means that family's tools are simply not registered,
// so a gateway that hasn't initialised (say) docker still works.
type Deps struct {
	Logger *zap.Logger
	Audit  *audit.Writer
	Asset  *asset.Resolver
	RBAC   *auth.Resolver

	Process  *process.Manager
	Systemd  *systemd.Manager
	Perf     *perf.Manager
	Logs     *logs.Manager
	Docker   *docker.Manager
	Hardware *hardware.Manager
	Kernel   *kernel.Manager
	Storage  *storage.Manager
	NetTools *nettools.Manager
	Cron     *cron.Manager
	Pkg      *pkg.Manager
	SysUser  *sysuser.Manager
	SecAudit *secaudit.Manager
	Firewall *firewall.Manager

	DBQuery *dbquery.Service
	OSS     *oss.Connector

	// Knowledge backs knowledge_search + distill_resolution. Nil = those tools
	// are not registered.
	Knowledge *knowledge.Service

	NodeRunner tools.NodeRunner
}

// RegisterAll registers every available ops tool family on reg. Safe to call
// once, after ai.New(); the runner holds the same *tools.Registry pointer so
// the late additions are picked up on the next turn.
func RegisterAll(reg *tools.Registry, deps Deps) {
	registerProcessTools(reg, deps)
	registerServiceTools(reg, deps)
	registerMetricsTools(reg, deps)
	registerLogTools(reg, deps)
	registerDockerTools(reg, deps)
	registerNetworkTools(reg, deps)
	registerFirewallTools(reg, deps)
	registerPackageTools(reg, deps)
	registerCronTools(reg, deps)
	registerSysUserTools(reg, deps)
	registerSecAuditTools(reg, deps)
	registerStorageKernelTools(reg, deps)
	registerK8sTools(reg, deps)
	registerDBTools(reg, deps)
	registerOSSTools(reg, deps)
	registerKnowledgeTools(reg, deps)
}

// ===== shared helpers =====

// view marshals payload into the standard {_view,data} envelope (truncated to
// the tool output budget) so the UI can route to a humanised renderer.
func view(name string, payload any) (string, error) {
	b, err := json.Marshal(map[string]any{"_view": name, "data": payload})
	if err != nil {
		return "", err
	}
	out, _ := tools.Truncate(string(b))
	return out, nil
}

// objSchema builds a JSON-schema object. props is the property body (no outer
// braces); required lists the required property names.
func objSchema(props string, required ...string) json.RawMessage {
	req, _ := json.Marshal(required)
	return json.RawMessage(fmt.Sprintf(`{"type":"object","properties":{%s},"required":%s}`, props, req))
}

const nodeIDProp = `"node_id":{"type":"integer","description":"目标节点 ID"}`

func parseNodeID(raw json.RawMessage) (uint64, error) {
	var a struct {
		NodeID uint64 `json:"node_id"`
	}
	if err := json.Unmarshal(raw, &a); err != nil {
		return 0, err
	}
	if a.NodeID == 0 {
		return 0, fmt.Errorf("node_id required")
	}
	return a.NodeID, nil
}

// strArg extracts a required non-empty string field from the raw JSON args.
func strArg(raw json.RawMessage, field string) (string, error) {
	var m map[string]any
	if err := json.Unmarshal(raw, &m); err != nil {
		return "", err
	}
	v, _ := m[field].(string)
	if strings.TrimSpace(v) == "" {
		return "", fmt.Errorf("%s required", field)
	}
	return v, nil
}

// writeDryRun is the plan-mode preview for a mutating tool.
func writeDryRun(action string) tools.RunFn {
	return func(_ context.Context, _ tools.ToolCtx, raw json.RawMessage) (string, error) {
		return fmt.Sprintf("[plan mode] 将%s；参数: %s", action, strings.TrimSpace(string(raw))), nil
	}
}

// nodeReadTool registers a low-danger, node-scoped read tool. run receives the
// parsed nodeID; it should return a {_view,data} envelope via view().
func nodeReadTool(reg *tools.Registry, name, desc string, schema json.RawMessage,
	run func(ctx context.Context, t tools.ToolCtx, raw json.RawMessage, nodeID uint64) (string, error)) {
	reg.Register(&tools.Tool{
		Name:                name,
		Description:         desc,
		Danger:              tools.DangerLow,
		RequiredAssetAction: asset.ActionConnect,
		Schema:              schema,
		Run: func(ctx context.Context, t tools.ToolCtx, raw json.RawMessage) (string, error) {
			nid, err := parseNodeID(raw)
			if err != nil {
				return "", err
			}
			return run(ctx, t, raw, nid)
		},
	})
}

// nodeWriteTool registers a high-danger, node-scoped mutating tool gated on the
// given RBAC perm (mirroring the REST route) plus asset "connect".
func nodeWriteTool(reg *tools.Registry, name, desc, perm, dryAction string, schema json.RawMessage,
	run func(ctx context.Context, t tools.ToolCtx, raw json.RawMessage, nodeID uint64) (string, error)) {
	reg.Register(&tools.Tool{
		Name:                name,
		Description:         desc,
		Danger:              tools.DangerHigh,
		RequiredPerm:        perm,
		RequiredAssetAction: asset.ActionConnect,
		Schema:              schema,
		Run: func(ctx context.Context, t tools.ToolCtx, raw json.RawMessage) (string, error) {
			nid, err := parseNodeID(raw)
			if err != nil {
				return "", err
			}
			return run(ctx, t, raw, nid)
		},
		DryRun: writeDryRun(dryAction),
	})
}
