package tools

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"time"

	aimodel "github.com/michongs/jumpserver-anonymous/internal/ai/model"
	airepo "github.com/michongs/jumpserver-anonymous/internal/ai/repo"
	"github.com/michongs/jumpserver-anonymous/internal/asset"
	"github.com/michongs/jumpserver-anonymous/internal/auth"
)

// Decision tells the runner what to do with an LLM-issued tool call.
type Decision int

const (
	DecisionRun     Decision = iota // execute Run normally
	DecisionDryRun                  // execute DryRun (plan mode)
	DecisionApprove                 // execute Run after user approves the persisted invocation
	DecisionReject                  // tell the model the user rejected
	DecisionDeny                    // policy says no (auth/asset failure)
)

// Approver is implemented by the runner: it stores an invocation as pending
// and pushes a permission_required SSE event, returning once the user has
// approved or the timeout elapses.
type Approver interface {
	RequestApproval(ctx context.Context, inv *aimodel.AIToolInvocation, summary string) (bool, error)
}

// PermissionGate makes the run/dryrun/approve decision per call.
type PermissionGate struct {
	Mode    aimodel.PermissionMode
	Asset   *asset.Resolver
	RBAC    *auth.Resolver
	InvRepo *airepo.InvocationRepo
	Approve Approver

	// Pre-approved tools (e.g. "list_nodes") that bypass the approval flow even
	// in normal mode regardless of Danger level.
	AlwaysAllow map[string]bool
	// Timeout for waiting on the user's decision.
	ApprovalTimeout time.Duration
}

// Authorize checks RBAC + asset rules and reports the decision to make.
// It does NOT write to the DB; the runner persists the invocation.
func (g *PermissionGate) Authorize(ctx context.Context, t *Tool, raw json.RawMessage, userID uint64) (Decision, string, error) {
	// 1. Permission point check (cheap, fail fast).
	if t.RequiredPerm != "" && g.RBAC != nil {
		ok, err := g.RBAC.Has(ctx, userID, t.RequiredPerm)
		if err != nil {
			return DecisionDeny, "", err
		}
		if !ok {
			return DecisionDeny, "permission denied: " + t.RequiredPerm, nil
		}
	}
	// 2. Asset-level check (when the tool input names a node).
	if t.RequiredAssetAction != "" && g.Asset != nil {
		var probe struct {
			NodeID uint64 `json:"node_id"`
		}
		_ = json.Unmarshal(raw, &probe)
		if probe.NodeID == 0 {
			return DecisionDeny, "tool input missing node_id", nil
		}
		ok, err := g.Asset.Check(ctx, userID, probe.NodeID, t.RequiredAssetAction)
		if err != nil {
			return DecisionDeny, "", err
		}
		if !ok {
			return DecisionDeny, fmt.Sprintf("not authorised to %s on node %d", t.RequiredAssetAction, probe.NodeID), nil
		}
	}
	// 3. Mode-based decision.
	switch g.Mode {
	case aimodel.PermModeBypass:
		return DecisionRun, "", nil
	case aimodel.PermModePlan:
		switch t.Danger {
		case DangerLow:
			return DecisionRun, "", nil
		default:
			return DecisionDryRun, "", nil
		}
	default: // normal
		if g.AlwaysAllow[t.Name] || t.Danger == DangerLow {
			return DecisionRun, "", nil
		}
		return DecisionApprove, "", nil
	}
}

// Wait blocks until the user approves/rejects an invocation or the timeout
// elapses. The invocation row is created up-front (status=pending) so the
// frontend can render an approval prompt.
func (g *PermissionGate) Wait(ctx context.Context, inv *aimodel.AIToolInvocation, summary string) (bool, error) {
	if g.Approve == nil {
		return false, errors.New("no approver wired")
	}
	timeout := g.ApprovalTimeout
	if timeout <= 0 {
		timeout = 2 * time.Minute
	}
	approveCtx, cancel := context.WithTimeout(ctx, timeout)
	defer cancel()
	return g.Approve.RequestApproval(approveCtx, inv, summary)
}
