// Package breakglass implements emergency access (应急访问 / "break-glass"): a
// controlled fast-path to privileged access for incidents, built ON TOP of the
// existing approval + asset-grant + audit + notification machinery rather than
// as a parallel grant system.
//
// Access is granted by reusing two existing, well-understood mechanisms:
//
//   - a time-boxed AssetGrant (Source="break_glass") — so every asset-resolver
//     gate (desktop / dbquery / sftp / files / …) honours the access and the
//     workspace lists the node, and
//   - a break_glass ApprovalGrant — so every approval enforcement point
//     (webssh / telnet / RDP / dbcli / tcpfwd / …) honours it on
//     approval-flagged nodes, and the renewal-aware WatchGrant server-side
//     cutoff applies. approval.VerifyGrant treats a break_glass grant as
//     satisfying any business-type gate (that is the whole point of emergency
//     access).
//
// The BreakGlassActivation row is the governance object that links both grants
// and tracks the lifecycle. Compensating controls are non-negotiable:
// mandatory justification + (optional) incident ref, a hard time-box capped
// three ways (policy ∩ global ∩ approval template), immediate critical-path
// audit + security fan-out, forced session recording (inherited — every node
// session is recorded), mandatory post-use review with separation-of-duties,
// and an admin kill-switch that severs live sessions.
package breakglass

import (
	"context"
	"errors"
	"fmt"
	"strconv"
	"strings"
	"time"

	"github.com/google/uuid"
	"github.com/michongs/wayfort/internal/approval"
	"github.com/michongs/wayfort/internal/asset"
	"github.com/michongs/wayfort/internal/audit"
	"github.com/michongs/wayfort/internal/config"
	"github.com/michongs/wayfort/internal/model"
	"github.com/michongs/wayfort/internal/notifications"
	"github.com/michongs/wayfort/internal/repo"
	"go.uber.org/zap"
)

// breakGlassActions is the action set an emergency AssetGrant carries — the full
// interactive + file + forwarding surface, since an incident responder can't
// predict which capability they'll need.
const breakGlassActions = "connect,sftp_read,sftp_write,port_forward,upload,download,exec"

var (
	// ErrDisabled is returned when the global break-glass switch is off.
	ErrDisabled = errors.New("break-glass is disabled")
	// ErrNoPolicy is returned when no enabled policy governs the target asset.
	ErrNoPolicy = errors.New("no break-glass policy governs this asset")
	// ErrAuditRefused is returned when the high-sensitivity audit write fails;
	// the activation is refused so emergency access never happens unaudited.
	ErrAuditRefused = errors.New("break-glass refused: emergency-access audit could not be recorded")
)

// SessionTerminator is implemented by the SSH/Telnet gateway and the desktop
// manager — the owners of live sessions the kill-switch must sever.
type SessionTerminator interface {
	TerminateSession(ctx context.Context, sessionID string) bool
}

// Deps bundles everything the orchestration glue needs.
type Deps struct {
	Repo        *repo.BreakGlassRepo
	Approval    *approval.Service
	Grants      *repo.GrantRepo
	Asset       *asset.Resolver
	Audit       *audit.Writer
	Dispatcher  *notifications.Dispatcher
	Sessions    *repo.SessionRepo
	Nodes       *repo.NodeRepo
	Users       *repo.UserRepo
	Terminators []SessionTerminator
	// Settings returns the live global break-glass config (read at request time
	// so a settings-center change applies without a restart).
	Settings func() config.BreakGlassConfig
	// BaseCtx is the app-lifecycle context used for detached notification work
	// (never the request ctx — it dies on response; never context.Background — it
	// outlives shutdown). Mirrors the anomaly detector's dispatchContext rule.
	BaseCtx context.Context
	Logger  *zap.Logger
}

// Service is the break-glass orchestrator.
type Service struct {
	deps Deps
	log  *zap.Logger
}

// New builds the service. Logger defaults to a no-op.
func New(d Deps) *Service {
	log := d.Logger
	if log == nil {
		log = zap.NewNop()
	}
	return &Service{deps: d, log: log}
}

func (s *Service) cfg() config.BreakGlassConfig {
	if s == nil || s.deps.Settings == nil {
		return config.BreakGlassConfig{}
	}
	return s.deps.Settings()
}

// Enabled reports whether the global switch is on.
func (s *Service) Enabled() bool { return s.cfg().Enabled }

// ---------------------------------------------------------------------------
// Activation
// ---------------------------------------------------------------------------

// ActivateInput is the request from a user (or the workspace gate) to break the
// glass on a node.
type ActivateInput struct {
	NodeID        uint64
	PolicyID      uint64 // 0 = auto-match the most specific enabled policy
	Justification string
	IncidentRef   string
	Mode          model.BreakGlassMode // preferred mode; fail_open downgrades to pre_approved when not permitted
	DurationSec   int                  // requested window; capped policy ∩ global ∩ template

	RequesterID   uint64
	RequesterName string
	ClientIP      string
}

// Activate validates the request against the governing policy + global gates,
// records the critical-path request audit (fail-closed), then either grants
// immediate access (fail-open) or opens an approval request (pre-approved).
func (s *Service) Activate(ctx context.Context, in ActivateInput) (*model.BreakGlassActivation, error) {
	cfg := s.cfg()
	if !cfg.Enabled {
		return nil, ErrDisabled
	}
	if in.RequesterID == 0 {
		return nil, errors.New("break-glass: requester required")
	}
	if strings.TrimSpace(in.Justification) == "" {
		return nil, errors.New("break-glass: justification is required")
	}
	if s.deps.Nodes == nil || s.deps.Repo == nil || s.deps.Approval == nil {
		return nil, errors.New("break-glass: subsystem not initialised")
	}

	node, err := s.deps.Nodes.FindByID(ctx, in.NodeID)
	if err != nil {
		return nil, fmt.Errorf("break-glass: load node: %w", err)
	}
	if node == nil {
		return nil, errors.New("break-glass: node not found")
	}

	policy, err := s.resolvePolicy(ctx, in.PolicyID, node)
	if err != nil {
		return nil, err
	}
	if policy == nil {
		return nil, ErrNoPolicy
	}
	if policy.RequireIncidentRef && strings.TrimSpace(in.IncidentRef) == "" {
		return nil, errors.New("break-glass: this policy requires an incident / ticket reference")
	}

	effSec := s.cappedDuration(policy, cfg, in.DurationSec)
	if effSec <= 0 {
		return nil, errors.New("break-glass: effective duration is zero (check policy / global caps)")
	}

	// Decide the effective mode. Fail-open requires BOTH the policy and the
	// global switch, and is impossible when the policy demands dual-auth (a
	// second human). Otherwise the request routes through approval.
	failOpen := in.Mode == model.BreakGlassModeFailOpen &&
		policy.AllowFailOpen && cfg.AllowFailOpen && !policy.RequireDualAuth
	mode := model.BreakGlassModePreApproved
	if failOpen {
		mode = model.BreakGlassModeFailOpen
	}
	reviewRequired := policy.RequirePostUseReview || cfg.RequireReview || failOpen

	act := &model.BreakGlassActivation{
		ID:             uuid.NewString(),
		PolicyID:       &policy.ID,
		PolicyName:     policy.Name,
		RequesterID:    in.RequesterID,
		RequesterName:  in.RequesterName,
		ResourceType:   "node",
		ResourceID:     strconv.FormatUint(node.ID, 10),
		ResourceName:   node.Name,
		Justification:  strings.TrimSpace(in.Justification),
		IncidentRef:    strings.TrimSpace(in.IncidentRef),
		Mode:           mode,
		Status:         model.BreakGlassPending,
		ReviewRequired: reviewRequired,
		ClientIP:       in.ClientIP,
	}

	// Critical-path audit BEFORE any access is granted. Fail-closed: if the
	// blocking audit queue can't accept this, refuse the whole activation —
	// emergency access must never happen without a durable record.
	if err := s.critical(ctx, model.AuditBreakGlassRequest, act,
		fmt.Sprintf("mode=%s policy=%s incident=%s duration_sec=%d justification=%s",
			mode, policy.Name, act.IncidentRef, effSec, truncate(act.Justification, 400))); err != nil {
		return nil, ErrAuditRefused
	}

	if err := s.deps.Repo.CreateActivation(ctx, act); err != nil {
		return nil, fmt.Errorf("break-glass: persist activation: %w", err)
	}

	title := fmt.Sprintf("应急访问 break-glass：%s", node.Name)
	reason := fmt.Sprintf("[break-glass] %s | 工单:%s", truncate(act.Justification, 200), valOr(act.IncidentRef, "-"))

	if failOpen {
		req, grant, err := s.deps.Approval.IssueEmergencyGrant(ctx, approval.EmergencyGrantInput{
			RequesterID:   in.RequesterID,
			RequesterName: in.RequesterName,
			ResourceType:  "node",
			ResourceID:    act.ResourceID,
			Title:         title,
			Reason:        reason,
			ClientIP:      in.ClientIP,
			DurationSec:   effSec,
		})
		if err != nil {
			// Could not mint the grant — mark the activation rejected so it's not
			// left dangling as "pending forever".
			act.Status = model.BreakGlassRejected
			act.RevokeReason = "emergency grant issuance failed: " + err.Error()
			_ = s.deps.Repo.SaveActivation(ctx, act)
			return nil, fmt.Errorf("break-glass: issue emergency grant: %w", err)
		}
		if err := s.activateWithGrant(ctx, act, req.ID, grant); err != nil {
			return nil, err
		}
		s.notify(ctx, "已激活", act)
		return act, nil
	}

	// Pre-approved: open a break_glass approval request. The reconciler (and the
	// detail endpoint) promote the activation to active once it's approved.
	out, err := s.deps.Approval.CreateRequest(ctx, &approval.CreateRequestInput{
		BusinessType:  model.ApprovalBizBreakGlass,
		Title:         title,
		Reason:        reason,
		ResourceType:  "node",
		ResourceID:    act.ResourceID,
		WindowStart:   time.Now(),
		WindowEnd:     time.Now().Add(time.Duration(effSec) * time.Second),
		RequesterID:   in.RequesterID,
		RequesterName: in.RequesterName,
		ClientIP:      in.ClientIP,
	})
	if err != nil {
		act.Status = model.BreakGlassRejected
		act.RevokeReason = "approval request creation failed: " + err.Error()
		_ = s.deps.Repo.SaveActivation(ctx, act)
		return nil, fmt.Errorf("break-glass: create approval request: %w", err)
	}
	act.ApprovalRequestID = out.Request.ID
	if out.AutoApproved && out.Grant != nil {
		if err := s.activateWithGrant(ctx, act, out.Request.ID, out.Grant); err != nil {
			return nil, err
		}
		s.notify(ctx, "已激活", act)
		return act, nil
	}
	if err := s.deps.Repo.SaveActivation(ctx, act); err != nil {
		return nil, fmt.Errorf("break-glass: persist activation: %w", err)
	}
	// Tell the security team an emergency request is waiting so they expedite.
	s.notify(ctx, "申请中(待审批)", act)
	return act, nil
}

// activateWithGrant mints the AssetGrant alongside the approval grant, flips the
// activation to active, and records the activate critical event. If the audit
// write fails AFTER access was granted, the access is rolled back so the window
// can never be open without an activate record.
func (s *Service) activateWithGrant(ctx context.Context, act *model.BreakGlassActivation,
	requestID string, grant *model.ApprovalGrant) error {
	nodeID, _ := strconv.ParseUint(act.ResourceID, 10, 64)

	// Re-anchor the window to the ACTUAL activation moment. The approval grant's
	// window is anchored at request-creation time; for a pre-approved request
	// approved minutes later, copying it verbatim would hand the user a window
	// that has already (partly) elapsed. We keep the approved DURATION but start
	// it now. The duration is already capped (policy ∩ global ∩ template), so
	// re-anchoring can never exceed the caps.
	dur := grant.NotAfter.Sub(grant.NotBefore)
	if dur <= 0 {
		dur = 30 * time.Minute // safety floor if the upstream window collapsed
	}
	now := time.Now()
	notBefore := now
	notAfter := now.Add(dur)

	act.ApprovalRequestID = requestID
	act.ApprovalGrantID = grant.ID
	act.NotAfter = &notAfter

	// CRITICAL: write the activate audit BEFORE minting the broad emergency
	// AssetGrant. Audit gates access, never the reverse. The approval grant was
	// already issued upstream (and recorded in the hash-chained approval ledger),
	// so on audit backpressure we roll it back rather than letting the broad
	// AssetGrant come into existence unaudited.
	if err := s.critical(ctx, model.AuditBreakGlassActivate, act,
		fmt.Sprintf("mode=%s grant=%s not_after=%s", act.Mode, grant.ID, notAfter.Format(time.RFC3339))); err != nil {
		if s.deps.Approval != nil {
			_ = s.deps.Approval.RevokeGrant(ctx, grant.ID, act.RequesterID, "break-glass: activate audit refused")
		}
		act.Status = model.BreakGlassRejected
		act.RevokeReason = "activate audit refused"
		_ = s.deps.Repo.SaveActivation(ctx, act)
		return ErrAuditRefused
	}

	// Align the approval grant's window with the re-anchored window so the
	// flagged-node enforcement path (CheckEnforced → WatchGrant) and the asset
	// path agree on when access ends.
	if s.deps.Approval != nil {
		if err := s.deps.Approval.SetGrantWindow(ctx, grant.ID, notBefore, notAfter); err != nil {
			s.log.Warn("break-glass: re-anchor approval grant failed", zap.String("grant", grant.ID), zap.Error(err))
		}
	}

	// Mint the emergency AssetGrant (drives asset.Resolver.Check on every
	// non-flagged protocol + workspace visibility).
	if s.deps.Grants != nil {
		ag := &model.AssetGrant{
			GranteeType: model.GranteeUser,
			GranteeID:   act.RequesterID,
			SubjectType: model.SubjectNode,
			SubjectID:   nodeID,
			Actions:     breakGlassActions,
			ValidFrom:   &notBefore,
			ValidTo:     &notAfter,
			Source:      "break_glass",
			CreatedBy:   act.RequesterID,
			CreatedAt:   now,
		}
		if err := s.deps.Grants.Create(ctx, ag); err != nil {
			// Asset grant failed after the audit + approval grant: revoke for
			// consistency and reject the activation.
			if s.deps.Approval != nil {
				_ = s.deps.Approval.RevokeGrant(ctx, grant.ID, act.RequesterID, "break-glass: asset grant mint failed")
			}
			act.Status = model.BreakGlassRejected
			act.RevokeReason = "asset grant mint failed: " + err.Error()
			_ = s.deps.Repo.SaveActivation(ctx, act)
			return fmt.Errorf("break-glass: mint asset grant: %w", err)
		}
		act.AssetGrantID = &ag.ID
	}
	if s.deps.Asset != nil {
		s.deps.Asset.Invalidate(ctx, act.RequesterID) // ACL cache: new grant visible now
	}

	act.ActivatedAt = &now
	act.Status = model.BreakGlassActive
	if err := s.deps.Repo.SaveActivation(ctx, act); err != nil {
		return fmt.Errorf("break-glass: persist activation: %w", err)
	}
	return nil
}

// ---------------------------------------------------------------------------
// Kill-switch + review
// ---------------------------------------------------------------------------

// Revoke is the admin kill-switch: it severs access and live sessions
// immediately. Gated on system:admin at the route layer (privilege separation).
func (s *Service) Revoke(ctx context.Context, id string, by uint64, byName, reason string) (*model.BreakGlassActivation, error) {
	act, err := s.deps.Repo.FindActivation(ctx, id)
	if err != nil {
		return nil, err
	}
	if act == nil {
		return nil, errors.New("break-glass: activation not found")
	}
	switch act.Status {
	case model.BreakGlassActive, model.BreakGlassPending:
	default:
		return nil, fmt.Errorf("break-glass: activation in state %q cannot be revoked", act.Status)
	}

	wasActive := act.Status == model.BreakGlassActive
	if wasActive {
		s.revokeAccess(ctx, act, by, reason)
		s.terminateSessions(ctx, act)
	} else if act.ApprovalRequestID != "" {
		// Pending — cancel the in-flight approval request so it can't later be
		// approved into an active grant.
		_ = s.deps.Approval.Cancel(ctx, act.ApprovalRequestID, act.RequesterID, "revoked by admin: "+reason)
	}

	now := time.Now()
	act.RevokedBy = &by
	act.RevokedByName = byName
	act.RevokedAt = &now
	act.RevokeReason = truncate(reason, 255)
	if wasActive && act.ReviewRequired {
		// Ended by the kill-switch but still owes a post-use review; RevokedAt
		// distinguishes "已吊销·待复核" from a natural expiry in the same state.
		act.Status = model.BreakGlassUnderReview
	} else {
		// Both active-no-review and pending kills are admin revocations, not
		// approver rejections — keep them counted under "revoked".
		act.Status = model.BreakGlassRevoked
	}
	if err := s.deps.Repo.SaveActivation(ctx, act); err != nil {
		return nil, err
	}

	if err := s.critical(ctx, model.AuditBreakGlassRevoke, act,
		fmt.Sprintf("revoked_by=%s reason=%s", byName, truncate(reason, 200))); err != nil {
		// Access is already revoked; surface the audit-backpressure but don't
		// undo the kill-switch (the safe direction is to keep access closed).
		s.log.Warn("break-glass: revoke audit failed", zap.String("id", id), zap.Error(err))
	}
	s.notify(ctx, "已被管理员吊销", act)
	return act, nil
}

// SubmitReview records a post-use review. Separation of duties: the reviewer
// must not be the requester. Closes the activation.
func (s *Service) SubmitReview(ctx context.Context, id string, reviewerID uint64, reviewerName string,
	verdict model.BreakGlassReviewVerdict, comment string) (*model.BreakGlassActivation, error) {
	act, err := s.deps.Repo.FindActivation(ctx, id)
	if err != nil {
		return nil, err
	}
	if act == nil {
		return nil, errors.New("break-glass: activation not found")
	}
	if act.Status != model.BreakGlassUnderReview {
		return nil, errors.New("break-glass: activation is not awaiting review")
	}
	if act.RequesterID == reviewerID {
		return nil, errors.New("break-glass: the requester may not review their own emergency access")
	}
	if strings.TrimSpace(comment) == "" {
		return nil, errors.New("break-glass: a review comment is required")
	}
	switch verdict {
	case model.BreakGlassVerdictJustified, model.BreakGlassVerdictUnjustified, model.BreakGlassVerdictInconclusive:
	default:
		return nil, fmt.Errorf("break-glass: invalid review verdict %q", verdict)
	}

	now := time.Now()
	act.ReviewerID = &reviewerID
	act.ReviewerName = reviewerName
	act.ReviewedAt = &now
	act.ReviewVerdict = verdict
	act.ReviewComment = truncate(comment, 2000)
	act.Status = model.BreakGlassClosed
	if err := s.deps.Repo.SaveActivation(ctx, act); err != nil {
		return nil, err
	}
	if err := s.critical(ctx, model.AuditBreakGlassReview, act,
		fmt.Sprintf("reviewer=%s verdict=%s comment=%s", reviewerName, verdict, truncate(comment, 200))); err != nil {
		s.log.Warn("break-glass: review audit failed", zap.String("id", id), zap.Error(err))
	}
	return act, nil
}

// ---------------------------------------------------------------------------
// Reads
// ---------------------------------------------------------------------------

// Get returns one activation, reconciling a pending one on read so the UI sees
// the active promotion promptly after approval.
func (s *Service) Get(ctx context.Context, id string) (*model.BreakGlassActivation, error) {
	act, err := s.deps.Repo.FindActivation(ctx, id)
	if err != nil || act == nil {
		return act, err
	}
	if act.Status == model.BreakGlassPending {
		s.reconcilePending(ctx, act)
	}
	return act, nil
}

// List passes through to the repo (admin governance list).
func (s *Service) List(ctx context.Context, f repo.BreakGlassFilter) ([]model.BreakGlassActivation, int64, error) {
	return s.deps.Repo.ListActivations(ctx, f)
}

// Stats backs the governance overview.
func (s *Service) Stats(ctx context.Context) (*repo.BreakGlassStats, error) {
	return s.deps.Repo.Stats(ctx)
}

// Policies CRUD pass-throughs.
func (s *Service) ListPolicies(ctx context.Context) ([]model.BreakGlassPolicy, error) {
	return s.deps.Repo.ListPolicies(ctx)
}
func (s *Service) CreatePolicy(ctx context.Context, p *model.BreakGlassPolicy) error {
	return s.deps.Repo.CreatePolicy(ctx, p)
}
func (s *Service) UpdatePolicy(ctx context.Context, p *model.BreakGlassPolicy) error {
	return s.deps.Repo.UpdatePolicy(ctx, p)
}
func (s *Service) DeletePolicy(ctx context.Context, id uint64) error {
	return s.deps.Repo.DeletePolicy(ctx, id)
}
func (s *Service) FindPolicy(ctx context.Context, id uint64) (*model.BreakGlassPolicy, error) {
	return s.deps.Repo.FindPolicy(ctx, id)
}

// ---------------------------------------------------------------------------
// Reconciler
// ---------------------------------------------------------------------------

// Run drives the periodic reconciler: it promotes approved pending activations
// to active, and expires active activations whose window has lapsed (severing
// sessions on non-approval-flagged nodes that WatchGrant doesn't cover).
func (s *Service) Run(ctx context.Context) error {
	t := time.NewTicker(20 * time.Second)
	defer t.Stop()
	for {
		select {
		case <-ctx.Done():
			return nil
		case <-t.C:
			s.reconcile(ctx)
		}
	}
}

func (s *Service) reconcile(ctx context.Context) {
	pending, err := s.deps.Repo.ListByStatus(ctx, model.BreakGlassPending, 200)
	if err != nil {
		s.log.Warn("break-glass: list pending failed", zap.Error(err))
	}
	for i := range pending {
		s.reconcilePending(ctx, &pending[i])
	}
	active, err := s.deps.Repo.ListByStatus(ctx, model.BreakGlassActive, 200)
	if err != nil {
		s.log.Warn("break-glass: list active failed", zap.Error(err))
	}
	now := time.Now()
	for i := range active {
		a := &active[i]
		if a.NotAfter != nil && !now.Before(*a.NotAfter) {
			s.expire(ctx, a)
		}
	}
}

// reconcilePending advances a pending pre-approved activation based on its
// linked approval request: granted → active; rejected/expired → terminal.
func (s *Service) reconcilePending(ctx context.Context, act *model.BreakGlassActivation) {
	// Re-load the freshest row first. A reconcile sweep snapshots the pending
	// list once, and a peer gateway (HA) may have already promoted this row — so
	// a stale copy must never re-mint grants. We overwrite *act so the caller
	// (the Get endpoint) sees the latest state, then only proceed if it is still
	// genuinely pending with no access minted yet.
	if fresh, err := s.deps.Repo.FindActivation(ctx, act.ID); err == nil && fresh != nil {
		*act = *fresh
	}
	if act.Status != model.BreakGlassPending || act.AssetGrantID != nil {
		return
	}
	if act.ApprovalRequestID == "" {
		return
	}
	detail, err := s.deps.Approval.GetRequest(ctx, act.ApprovalRequestID)
	if err != nil || detail == nil || detail.Request == nil {
		return
	}
	switch detail.Request.Status {
	case model.ApprovalReqApproved, model.ApprovalReqAutoApproved:
		if detail.Grant != nil && act.AssetGrantID == nil {
			if err := s.activateWithGrant(ctx, act, act.ApprovalRequestID, detail.Grant); err != nil {
				s.log.Warn("break-glass: activate-on-approval failed", zap.String("id", act.ID), zap.Error(err))
				return
			}
			s.notify(ctx, "已激活", act)
		}
	case model.ApprovalReqRejected:
		act.Status = model.BreakGlassRejected
		act.RevokeReason = "approval rejected"
		_ = s.deps.Repo.SaveActivation(ctx, act)
		s.notify(ctx, "审批被驳回", act)
	case model.ApprovalReqCancelled, model.ApprovalReqExpired:
		act.Status = model.BreakGlassRejected
		act.RevokeReason = "approval " + string(detail.Request.Status)
		_ = s.deps.Repo.SaveActivation(ctx, act)
	}
}

// expire ends an active activation whose window lapsed. Access is revoked
// (asset grant + approval grant) and live sessions are severed BEFORE the status
// changes, so enforcement is closed regardless of the resulting status. State
// asymmetry by design: a review-required activation lands in under_review (it
// still owes a sign-off to close), otherwise it terminates as expired.
func (s *Service) expire(ctx context.Context, act *model.BreakGlassActivation) {
	s.revokeAccess(ctx, act, act.RequesterID, "window expired")
	s.terminateSessions(ctx, act)
	if act.ReviewRequired {
		act.Status = model.BreakGlassUnderReview
	} else {
		act.Status = model.BreakGlassExpired
	}
	if err := s.deps.Repo.SaveActivation(ctx, act); err != nil {
		s.log.Warn("break-glass: persist expiry failed", zap.String("id", act.ID), zap.Error(err))
	}
	if err := s.critical(ctx, model.AuditBreakGlassExpire, act, "window expired"); err != nil {
		s.log.Warn("break-glass: expire audit failed", zap.String("id", act.ID), zap.Error(err))
	}
	s.notify(ctx, "已到期", act)
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

// revokeAccess deletes the emergency AssetGrant and revokes the break_glass
// ApprovalGrant. Best-effort and idempotent: each step tolerates already-gone.
func (s *Service) revokeAccess(ctx context.Context, act *model.BreakGlassActivation, by uint64, reason string) {
	if act.AssetGrantID != nil && s.deps.Grants != nil {
		if err := s.deps.Grants.Delete(ctx, *act.AssetGrantID); err != nil {
			s.log.Warn("break-glass: delete asset grant failed", zap.Uint64("grant", *act.AssetGrantID), zap.Error(err))
		}
		act.AssetGrantID = nil
	}
	if s.deps.Asset != nil {
		s.deps.Asset.Invalidate(ctx, act.RequesterID)
	}
	if act.ApprovalGrantID != "" && s.deps.Approval != nil {
		if err := s.deps.Approval.RevokeGrant(ctx, act.ApprovalGrantID, by, "break-glass: "+reason); err != nil {
			s.log.Warn("break-glass: revoke approval grant failed", zap.String("grant", act.ApprovalGrantID), zap.Error(err))
		}
	}
}

// terminateSessions severs every live session the requester holds on the target
// node. Tries each owner (SSH gateway, desktop manager); falls back to marking
// the row terminated for stale/foreign-owned sessions.
func (s *Service) terminateSessions(ctx context.Context, act *model.BreakGlassActivation) {
	if s.deps.Sessions == nil {
		return
	}
	nodeID, err := strconv.ParseUint(act.ResourceID, 10, 64)
	if err != nil {
		return
	}
	uid := act.RequesterID
	rows, err := s.deps.Sessions.List(ctx, repo.ListSessionFilter{
		UserID: &uid, NodeID: &nodeID, Status: string(model.SessionActive), Limit: 200,
	})
	if err != nil {
		s.log.Warn("break-glass: list sessions failed", zap.Error(err))
		return
	}
	now := time.Now()
	for _, row := range rows {
		handled := false
		for _, term := range s.deps.Terminators {
			if term != nil && term.TerminateSession(ctx, row.ID) {
				handled = true
				break
			}
		}
		if !handled {
			_ = s.deps.Sessions.Finish(ctx, row.ID, map[string]any{
				"status": model.SessionTerminated, "ended_at": &now,
			})
		}
	}
}

// policyGovernsNode reports whether a policy's scope actually applies to the
// node. This is the authorization predicate that BOTH the explicit-policy path
// and the auto-match path must honour — otherwise an explicit policy_id is a
// scope-bypass (a node-scoped policy meant for asset A would govern asset B).
func (s *Service) policyGovernsNode(ctx context.Context, p *model.BreakGlassPolicy, node *model.Node) bool {
	switch p.ScopeType {
	case model.BreakGlassScopeNode:
		return p.ScopeID != nil && *p.ScopeID == node.ID
	case model.BreakGlassScopeTag:
		if p.ScopeID == nil {
			return false
		}
		_, ok := s.nodeTagIDs(ctx, node.ID)[*p.ScopeID]
		return ok
	default: // all (and unset)
		return true
	}
}

// resolvePolicy returns the explicit policy (if id given) or the most-specific
// enabled policy governing the node: node-scoped > tag-scoped > all-scoped. An
// explicit policy is honoured ONLY if it is enabled AND its scope actually
// covers the node — a user cannot point a node-scoped policy at a different node.
func (s *Service) resolvePolicy(ctx context.Context, policyID uint64, node *model.Node) (*model.BreakGlassPolicy, error) {
	if policyID != 0 {
		p, err := s.deps.Repo.FindPolicy(ctx, policyID)
		if err != nil {
			return nil, err
		}
		if p == nil || !p.Enabled || !s.policyGovernsNode(ctx, p, node) {
			return nil, ErrNoPolicy
		}
		return p, nil
	}
	policies, err := s.deps.Repo.EnabledPolicies(ctx)
	if err != nil {
		return nil, err
	}
	var nodeMatch, tagMatch, allMatch *model.BreakGlassPolicy
	for i := range policies {
		p := &policies[i]
		if !s.policyGovernsNode(ctx, p, node) {
			continue
		}
		switch p.ScopeType {
		case model.BreakGlassScopeNode:
			if nodeMatch == nil {
				nodeMatch = p
			}
		case model.BreakGlassScopeTag:
			if tagMatch == nil {
				tagMatch = p
			}
		default:
			if allMatch == nil {
				allMatch = p
			}
		}
	}
	switch {
	case nodeMatch != nil:
		return nodeMatch, nil
	case tagMatch != nil:
		return tagMatch, nil
	default:
		return allMatch, nil
	}
}

func (s *Service) nodeTagIDs(ctx context.Context, nodeID uint64) map[uint64]struct{} {
	out := map[uint64]struct{}{}
	if s.deps.Repo == nil {
		return out
	}
	var ids []uint64
	_ = s.deps.Repo.DB().WithContext(ctx).Model(&model.NodeTag{}).
		Where("node_id = ?", nodeID).Pluck("tag_id", &ids).Error
	for _, id := range ids {
		out[id] = struct{}{}
	}
	return out
}

// cappedDuration computes the effective window: min(requested|policy, policy,
// global). A non-positive requested duration defaults to the full cap.
func (s *Service) cappedDuration(p *model.BreakGlassPolicy, cfg config.BreakGlassConfig, requested int) int {
	cap := p.MaxDurationSec
	if cap <= 0 {
		cap = 1800
	}
	if cfg.MaxDuration > 0 {
		if g := int(cfg.MaxDuration.Seconds()); g > 0 && g < cap {
			cap = g
		}
	}
	if requested <= 0 || requested > cap {
		return cap
	}
	return requested
}

// critical writes a high-sensitivity audit event on the blocking critical path.
// A nil writer is treated as success (feature degradation in tests) — production
// always wires it.
func (s *Service) critical(ctx context.Context, kind model.AuditEventKind, act *model.BreakGlassActivation, payload string) error {
	if s.deps.Audit == nil {
		return nil
	}
	var nodeID *uint64
	if id, err := strconv.ParseUint(act.ResourceID, 10, 64); err == nil {
		nodeID = &id
	}
	full := fmt.Sprintf("activation=%s resource=%s %s", act.ID, act.ResourceName, payload)
	return s.deps.Audit.LogCritical(ctx, model.AuditLog{
		Kind:     kind,
		UserID:   act.RequesterID,
		Username: act.RequesterName,
		NodeID:   nodeID,
		ClientIP: act.ClientIP,
		Payload:  truncate(full, 2000),
	})
}

// notify fans an emergency-access notice to the security team + the requester,
// in-app and by email, in a detached, shutdown-aware goroutine.
func (s *Service) notify(_ context.Context, action string, act *model.BreakGlassActivation) {
	disp := s.deps.Dispatcher
	if disp == nil {
		return
	}
	base := s.deps.BaseCtx
	if base == nil {
		base = context.Background()
	}
	snapshot := *act // copy: the caller may mutate act after we return
	go func() {
		ctx, cancel := context.WithTimeout(base, 30*time.Second)
		defer cancel()
		recips := disp.SecurityRecipients(ctx)
		if s.deps.Users != nil {
			if u, _ := s.deps.Users.FindByID(ctx, snapshot.RequesterID); u != nil {
				recips = append(recips, notifications.Recipient{UserID: u.ID, Email: u.Email})
			}
		}
		modeLabel := "审批激活"
		if snapshot.Mode == model.BreakGlassModeFailOpen {
			modeLabel = "自助破玻璃 (fail-open)"
		}
		var until time.Time
		if snapshot.NotAfter != nil {
			until = *snapshot.NotAfter
		}
		subject, htmlBody, text := notifications.BreakGlassEmail(action, snapshot.RequesterName,
			snapshot.ResourceName, snapshot.IncidentRef, snapshot.Justification, modeLabel, until)
		disp.Notify(ctx, notifications.Event{
			Kind:         model.NotifyKindBreakGlass,
			Severity:     model.NotifySevCritical,
			Title:        fmt.Sprintf("应急访问%s：%s → %s", action, snapshot.RequesterName, snapshot.ResourceName),
			Body:         fmt.Sprintf("方式 %s ｜ 工单 %s ｜ 理由：%s", modeLabel, valOr(snapshot.IncidentRef, "-"), truncate(snapshot.Justification, 160)),
			Link:         "/admin/break-glass",
			Data:         map[string]any{"activation_id": snapshot.ID, "mode": string(snapshot.Mode), "action": action},
			Recipients:   recips,
			SendEmail:    true,
			EmailSubject: subject,
			EmailHTML:    htmlBody,
			EmailText:    text,
			// Emergency access is never debounced — every event must reach the team.
			DebounceWindow: 0,
		})
	}()
}

func truncate(s string, max int) string {
	if len(s) <= max {
		return s
	}
	return s[:max]
}

func valOr(s, fallback string) string {
	if strings.TrimSpace(s) == "" {
		return fallback
	}
	return s
}
