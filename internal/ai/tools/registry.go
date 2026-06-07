// Package tools defines the catalogue of agent-callable operations.
// Each Tool declares its name, JSON schema, a Run handler for live execution
// and an optional DryRun for plan mode. The PermissionGate (gate.go) decides
// whether a call is allowed, requires user approval, or should be redirected
// to DryRun.
package tools

import (
	"context"
	"encoding/json"
	"fmt"
	"sort"
	"sync"

	aimodel "github.com/michongs/jumpserver-anonymous/internal/ai/model"
	"github.com/michongs/jumpserver-anonymous/internal/ai/provider"
	"github.com/michongs/jumpserver-anonymous/internal/asset"
	"github.com/michongs/jumpserver-anonymous/internal/audit"
	"github.com/michongs/jumpserver-anonymous/internal/auth"
	"github.com/michongs/jumpserver-anonymous/internal/repo"
)

// Danger ranks how cautious the gate should be when the agent invokes this tool.
type Danger string

const (
	DangerLow    Danger = "low"    // read-only, no approval needed even in normal mode
	DangerMedium Danger = "medium" // approval in normal; allowed in bypass
	DangerHigh   Danger = "high"   // approval in normal; dry-run in plan; allowed in bypass
)

// ToolCtx is supplied to every Run / DryRun invocation.
type ToolCtx struct {
	UserID   uint64
	Username string
	ConvID   string
	Audit    *audit.Writer
	Asset    *asset.Resolver
	RBAC     *auth.Resolver
	// Stream, when non-nil, lets a long-running tool push partial output to the
	// live UI as it is produced (e.g. ssh_exec streaming command output). The
	// final returned string is still the authoritative result fed to the model.
	Stream func(chunk string)
}

// Run handler signature.
type RunFn func(ctx context.Context, tctx ToolCtx, raw json.RawMessage) (string, error)

// Tool is one callable operation.
type Tool struct {
	Name               string
	Description        string
	Schema             json.RawMessage
	Danger             Danger
	RequiredPerm       string                // optional auth.Perm* code
	RequiredAssetAction string               // if set, tool input MUST carry a "node_id" field and gate will check asset access
	Run                RunFn
	DryRun             RunFn                 // if nil, the gate falls back to a generic dry-run notice
}

// Registry holds the global catalogue. Concurrent reads after registration.
type Registry struct {
	mu    sync.RWMutex
	tools map[string]*Tool
}

func NewRegistry() *Registry { return &Registry{tools: map[string]*Tool{}} }

func (r *Registry) Register(t *Tool) {
	if t == nil || t.Name == "" {
		return
	}
	r.mu.Lock()
	r.tools[t.Name] = t
	r.mu.Unlock()
}

func (r *Registry) Get(name string) *Tool {
	r.mu.RLock()
	defer r.mu.RUnlock()
	return r.tools[name]
}

func (r *Registry) Names() []string {
	r.mu.RLock()
	defer r.mu.RUnlock()
	out := make([]string, 0, len(r.tools))
	for name := range r.tools {
		out = append(out, name)
	}
	sort.Strings(out)
	return out
}

// Catalogue returns metadata for UI (no implementation pointers).
func (r *Registry) Catalogue() []ToolInfo {
	r.mu.RLock()
	defer r.mu.RUnlock()
	out := make([]ToolInfo, 0, len(r.tools))
	for _, t := range r.tools {
		out = append(out, ToolInfo{
			Name: t.Name, Description: t.Description,
			Danger: string(t.Danger), Schema: t.Schema,
			RequiredPerm: t.RequiredPerm,
		})
	}
	sort.Slice(out, func(i, j int) bool { return out[i].Name < out[j].Name })
	return out
}

type ToolInfo struct {
	Name         string          `json:"name"`
	Description  string          `json:"description"`
	Danger       string          `json:"danger"`
	RequiredPerm string          `json:"required_perm,omitempty"`
	Schema       json.RawMessage `json:"schema"`
}

// ProviderSchemas converts the registered tools (filtered to allowed) into
// provider.ToolSchema entries the LLM SDK can consume directly.
func (r *Registry) ProviderSchemas(allowed []string) []provider.ToolSchema {
	r.mu.RLock()
	defer r.mu.RUnlock()
	if len(allowed) == 0 {
		return nil
	}
	out := make([]provider.ToolSchema, 0, len(allowed))
	for _, name := range allowed {
		if t, ok := r.tools[name]; ok {
			out = append(out, provider.ToolSchema{
				Name: t.Name, Description: t.Description,
				JSONSchema: t.Schema,
			})
		}
	}
	// Deterministic order: the tool array forms the head of the Anthropic prompt
	// cache prefix, which is byte-compared. Any reordering (allow-list shuffles,
	// runner tool injection) would silently invalidate the cache, so sort by name.
	sort.Slice(out, func(i, j int) bool { return out[i].Name < out[j].Name })
	return out
}

// Deps is the set of cross-package services that concrete tool implementations
// need. Bundled into a single struct so RegisterAll has a clean signature.
type Deps struct {
	Asset       *asset.Resolver
	RBAC        *auth.Resolver
	Audit       *audit.Writer
	Nodes       *repo.NodeRepo
	Creds       *repo.CredentialRepo
	Proxies     *repo.ProxyRepo
	Sessions    *repo.SessionRepo
	AuditRepo   *repo.AuditRepo
	LoginHist   *repo.LoginHistoryRepo
	Users       *repo.UserRepo
	PortFwdMgr  PortForwardManager
	NodeRunner  NodeRunner
	SFTPRunner  SFTPRunner
	AgentRunner SubAgentRunner
}

// PortForwardManager / NodeRunner / SFTPRunner are local interfaces so the
// tools package doesn't depend on the heavy webssh/protocols packages.
type PortForwardManager interface {
	Create(ctx context.Context, userID uint64, username string, nodeID uint64, ttlSeconds int) (string, string, int, error)
	Close(ctx context.Context, id string) error
	ListByUser(ctx context.Context, userID uint64) ([]PortForwardEntry, error)
}

// PortForwardEntry is the minimal view of an active port forward returned by
// PortForwardManager.ListByUser, used by the port_forward_list tool.
type PortForwardEntry struct {
	ID        string `json:"id"`
	NodeID    uint64 `json:"node_id"`
	LocalHost string `json:"local_host"`
	LocalPort int    `json:"local_port"`
	ExpiresAt string `json:"expires_at,omitempty"`
}

type NodeRunner interface {
	Exec(ctx context.Context, userID uint64, nodeID uint64, command string, timeoutSec int) (stdout, stderr string, exit int, err error)
	// ExecStream is like Exec but invokes onChunk with stdout/stderr fragments
	// as they arrive (onChunk may be nil for buffered execution).
	ExecStream(ctx context.Context, userID uint64, nodeID uint64, command string, timeoutSec int, onChunk func(string)) (stdout, stderr string, exit int, err error)
}

type SFTPRunner interface {
	ListDir(ctx context.Context, userID, nodeID uint64, path string) ([]SFTPEntry, error)
	ReadFile(ctx context.Context, userID, nodeID uint64, path string, maxBytes int64) ([]byte, error)
	WriteFile(ctx context.Context, userID, nodeID uint64, path string, content []byte, mode uint32) error
	DeletePath(ctx context.Context, userID, nodeID uint64, path string) error
}

type SFTPEntry struct {
	Name    string `json:"name"`
	Path    string `json:"path"`
	IsDir   bool   `json:"is_dir"`
	Size    int64  `json:"size"`
	Mode    string `json:"mode"`
	ModTime string `json:"mod_time"`
}

// SubAgentRunner is used by the call_subagent tool to spawn a nested agent.
type SubAgentRunner interface {
	RunSub(ctx context.Context, parentConvID string, callerUserID uint64, agentID uint64, prompt string, permMode aimodel.PermissionMode) (string, error)
}

// MaxOutputBytes caps the per-tool string we feed back to the model so a single
// command's output can't blow the context window. Anything larger is truncated
// with a marker; the audit row keeps the full text.
const MaxOutputBytes = 8 * 1024

// Truncate returns (string, wasTruncated).
func Truncate(s string) (string, bool) {
	if len(s) <= MaxOutputBytes {
		return s, false
	}
	return s[:MaxOutputBytes] + fmt.Sprintf("\n…[truncated %d bytes]…", len(s)-MaxOutputBytes), true
}
