package approval

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"strings"
	"sync"
	"time"

	"github.com/google/uuid"
	"github.com/michongs/jumpserver-anonymous/internal/model"
	"github.com/michongs/jumpserver-anonymous/internal/repo"
	"go.uber.org/zap"
)

// ContextEnricher is the optional dependency the service uses to populate
// the Requester / Resource maps inside a PolicyContext. The bootstrap
// implements it via auth.Resolver + repo lookups; tests pass a noop.
type ContextEnricher interface {
	// Requester is the requester-side facts: roles, department, recent
	// login risk, etc. Always non-nil; missing fields are absent rather
	// than zero-valued.
	Requester(ctx context.Context, userID uint64) (map[string]any, error)
	// Resource is the resource-side facts: node criticality, asset tags,
	// CMDB attributes. Returns nil if the resource doesn't exist or
	// resourceID is empty.
	Resource(ctx context.Context, resourceType, resourceID string) (map[string]any, error)
}

// Service is the public surface used by API handlers and by enforcement
// points (webssh / dbcli / sftp / desktop / portforward / secrets). One
// process holds one Service.
type Service struct {
	repo     *repo.ApprovalRepo
	ledger   *Ledger
	policy   *PolicyEngine
	engine   Engine
	enricher ContextEnricher
	enforcer Enforcer
	notifier *FanoutNotifier
	hub      *Hub
	logger   *zap.Logger
	clock    func() time.Time
}

// Hub exposes the realtime fan-out so SSE handlers can subscribe.
func (s *Service) Hub() *Hub { return s.hub }

// Options bundles construction parameters. The Engine field is required;
// Notifier / Enricher / Enforcer are optional and default to no-ops.
type Options struct {
	Repo     *repo.ApprovalRepo
	Ledger   *Ledger
	Policy   *PolicyEngine
	Engine   Engine
	Enricher ContextEnricher
	Enforcer Enforcer
	Notifier *FanoutNotifier
	Logger   *zap.Logger
}

// NewService wires the public approval surface. Returns an error if a
// required dependency is missing — the bootstrap is expected to fail loud.
func NewService(opt Options) (*Service, error) {
	if opt.Repo == nil {
		return nil, errors.New("approval: repo required")
	}
	if opt.Ledger == nil {
		return nil, errors.New("approval: ledger required")
	}
	if opt.Policy == nil {
		return nil, errors.New("approval: policy required")
	}
	if opt.Engine == nil {
		return nil, errors.New("approval: engine required")
	}
	logger := opt.Logger
	if logger == nil {
		logger = zap.NewNop()
	}
	return &Service{
		repo:     opt.Repo,
		ledger:   opt.Ledger,
		policy:   opt.Policy,
		engine:   opt.Engine,
		enricher: opt.Enricher,
		enforcer: opt.Enforcer,
		notifier: opt.Notifier,
		hub:      NewHub(),
		logger:   logger,
		clock:    time.Now,
	}, nil
}

// SetClock injects a deterministic clock for tests.
func (s *Service) SetClock(fn func() time.Time) {
	if fn != nil {
		s.clock = fn
	}
}

// CreateRequestInput is the payload submitted by users.
type CreateRequestInput struct {
	BusinessType  model.ApprovalBusinessType `json:"business_type"`
	Title         string                     `json:"title"`
	Reason        string                     `json:"reason"`
	ResourceType  string                     `json:"resource_type"`
	ResourceID    string                     `json:"resource_id"`
	Payload       map[string]any             `json:"payload"`
	WindowStart   time.Time                  `json:"window_start"`
	WindowEnd     time.Time                  `json:"window_end"`
	RequesterID   uint64                     `json:"-"` // injected by handler
	RequesterName string                     `json:"-"`
	ClientIP      string                     `json:"-"`
}

// CreateOutput is what handlers return to the requester.
type CreateOutput struct {
	Request *model.ApprovalRequest `json:"request"`
	// AutoApproved indicates the policy auto-approved on creation; the
	// Grant field is populated in that case.
	AutoApproved bool                 `json:"auto_approved"`
	Grant        *model.ApprovalGrant `json:"grant,omitempty"`
}

// CreateRequest validates input, runs the policy engine, and either
// auto-approves (issuing a Grant) or spawns the first stage.
func (s *Service) CreateRequest(ctx context.Context, in *CreateRequestInput) (*CreateOutput, error) {
	if in == nil {
		return nil, errors.New("approval: nil input")
	}
	if !isKnownBiz(in.BusinessType) {
		return nil, fmt.Errorf("approval: unknown business_type %q", in.BusinessType)
	}
	if in.RequesterID == 0 {
		return nil, errors.New("approval: requester required")
	}
	if in.WindowEnd.Before(in.WindowStart) {
		return nil, errors.New("approval: window_end must be ≥ window_start")
	}
	if in.WindowEnd.IsZero() {
		in.WindowEnd = s.clock().Add(2 * time.Hour)
	}
	if in.WindowStart.IsZero() {
		in.WindowStart = s.clock()
	}

	now := s.clock()
	req := &model.ApprovalRequest{
		ID:            uuid.NewString(),
		BusinessType:  in.BusinessType,
		Title:         truncate(in.Title, 255),
		Reason:        truncate(in.Reason, 1024),
		RequesterID:   in.RequesterID,
		RequesterName: in.RequesterName,
		ResourceType:  in.ResourceType,
		ResourceID:    in.ResourceID,
		Payload:       jsonString(in.Payload),
		Status:        model.ApprovalReqPending,
		WindowStart:   in.WindowStart,
		WindowEnd:     in.WindowEnd,
		CurrentStage:  0,
		Version:       0,
		CreatedAt:     now,
		UpdatedAt:     now,
		ClientIP:      in.ClientIP,
	}
	if err := s.repo.CreateRequest(ctx, req); err != nil {
		return nil, fmt.Errorf("approval: persist request: %w", err)
	}

	// Genesis ledger event so the chain starts even for requests that
	// don't make it past validation downstream.
	if _, err := s.ledger.AppendForRequest(ctx, req.ID, model.ApprovalEvRequestCreated,
		req.RequesterID, req.RequesterName, map[string]any{
			"business_type": string(req.BusinessType),
			"resource":      req.ResourceType + ":" + req.ResourceID,
			"window_end":    req.WindowEnd,
		}); err != nil {
		s.logger.Warn("approval: ledger genesis failed", zap.Error(err))
	}

	pc, err := s.buildPolicyContext(ctx, req, in.Payload)
	if err != nil {
		return nil, fmt.Errorf("approval: build policy context: %w", err)
	}
	dec, err := s.policy.Evaluate(ctx, pc)
	if err != nil {
		return nil, fmt.Errorf("approval: policy evaluate: %w", err)
	}
	if dec == nil {
		// No template matched. Fail closed and surface a structured
		// error to the user.
		_, _ = s.ledger.AppendForRequest(ctx, req.ID, model.ApprovalEvRequestRejected, 0, "system",
			map[string]any{"reason": "no_template_matched"})
		_, _ = s.repo.UpdateRequestStatus(ctx, req.ID, req.Version, model.ApprovalReqRejected, -1, true, nil)
		return nil, fmt.Errorf("approval: no template matches business_type=%s resource=%s", req.BusinessType, req.ResourceType)
	}
	req.TemplateID = dec.TemplateID
	req.RiskLevel = dec.RiskLevel
	req.TotalStages = len(dec.Stages)

	_, _ = s.ledger.AppendForRequest(ctx, req.ID, model.ApprovalEvPolicyMatched, 0, "system",
		map[string]any{"template": dec.TemplateName, "template_id": dec.TemplateID})
	_, _ = s.ledger.AppendForRequest(ctx, req.ID, model.ApprovalEvRiskComputed, 0, "system",
		map[string]any{"risk_level": string(dec.RiskLevel)})

	// Persist policy-derived fields on the row (template / risk / totals).
	if err := s.repo.DB().WithContext(ctx).Model(&model.ApprovalRequest{}).
		Where("id = ?", req.ID).Updates(map[string]any{
		"template_id":  dec.TemplateID,
		"risk_level":   dec.RiskLevel,
		"total_stages": req.TotalStages,
		"updated_at":   s.clock(),
	}).Error; err != nil {
		return nil, err
	}

	if dec.AutoApproved {
		grant, err := s.finalApprove(ctx, req, dec, autoApproveActor, "system",
			model.ApprovalReqAutoApproved, dec.AutoApproveReason, 0)
		if err != nil {
			return nil, err
		}
		s.dispatchNotify(ctx, req, model.ApprovalEvAutoApproved, grant)
		return &CreateOutput{Request: req, AutoApproved: true, Grant: grant}, nil
	}

	// Spawn the first stage.
	if len(dec.Stages) == 0 {
		return nil, errors.New("approval: matched template has zero stages and no auto_approve")
	}
	stage0 := dec.Stages[0]
	if stage0.TimeoutSec == 0 && dec.DefaultTimeoutSec > 0 {
		stage0.TimeoutSec = dec.DefaultTimeoutSec
	}
	if _, err := s.engine.SpawnStage(ctx, req, 0, stage0); err != nil {
		return nil, fmt.Errorf("approval: spawn stage 0: %w", err)
	}
	s.dispatchNotify(ctx, req, model.ApprovalEvTaskCreated, nil)
	return &CreateOutput{Request: req, AutoApproved: false}, nil
}

const autoApproveActor uint64 = 0

// buildPolicyContext enriches a request with requester / resource facts.
func (s *Service) buildPolicyContext(ctx context.Context, req *model.ApprovalRequest,
	payload map[string]any) (*PolicyContext, error) {
	if payload == nil {
		payload = map[string]any{}
		if s := strings.TrimSpace(req.Payload); s != "" {
			_ = json.Unmarshal([]byte(s), &payload)
		}
	}
	pc := &PolicyContext{
		Request: *req,
		Payload: payload,
		Policy:  map[string]any{},
	}
	if s.enricher != nil {
		if m, err := s.enricher.Requester(ctx, req.RequesterID); err == nil && m != nil {
			pc.Requester = m
		}
		if m, err := s.enricher.Resource(ctx, req.ResourceType, req.ResourceID); err == nil && m != nil {
			pc.Resource = m
		}
	}
	if pc.Requester == nil {
		pc.Requester = map[string]any{}
	}
	if pc.Resource == nil {
		pc.Resource = map[string]any{}
	}
	return pc, nil
}

// Decide records an approver's verdict, advances the workflow, and issues
// a grant when the final stage approves.
func (s *Service) Decide(ctx context.Context, taskID uint64, in DecideInput) (*DecideOutput, error) {
	task, err := s.repo.FindTask(ctx, taskID)
	if err != nil {
		return nil, err
	}
	if task == nil {
		return nil, fmt.Errorf("approval: task %d not found", taskID)
	}
	req, err := s.repo.FindRequest(ctx, task.RequestID)
	if err != nil {
		return nil, err
	}
	if req == nil {
		return nil, fmt.Errorf("approval: request %s not found", task.RequestID)
	}
	if req.Status != model.ApprovalReqPending {
		return nil, fmt.Errorf("approval: request already in terminal state %q", req.Status)
	}

	outcome, err := s.engine.Decide(ctx, taskID, Decision{
		ApproverID: in.ApproverID,
		Approve:    in.Approve,
		Comment:    in.Comment,
	})
	if err != nil {
		return nil, err
	}

	out := &DecideOutput{Task: task, Request: req, StageOutcome: outcome.StageOutcome}

	switch outcome.StageOutcome {
	case StageRejected:
		_, _ = s.ledger.AppendForRequest(ctx, req.ID, model.ApprovalEvRequestRejected,
			in.ApproverID, "", map[string]any{"stage": task.Stage, "comment": in.Comment})
		now := s.clock()
		if _, err := s.repo.UpdateRequestStatus(ctx, req.ID, req.Version,
			model.ApprovalReqRejected, -1, true, &now); err != nil {
			return nil, err
		}
		req.Status = model.ApprovalReqRejected
		s.dispatchNotify(ctx, req, model.ApprovalEvRequestRejected, nil)
		out.FinalStatus = model.ApprovalReqRejected
		return out, nil
	case StageApproved:
		// Stage finished. Either advance, or — if it's the last stage —
		// finalise and issue the grant.
		nextStage := task.Stage + 1
		// We need the full plan to know how many stages there are. Read
		// from the template.
		spec, total, err := s.loadStage(ctx, req, nextStage)
		if err != nil {
			return nil, err
		}
		_, _ = s.ledger.AppendForRequest(ctx, req.ID, model.ApprovalEvStageAdvanced,
			0, "system", map[string]any{"from": task.Stage, "to": nextStage, "total": total})
		if nextStage >= total {
			// Final approval — issue the grant.
			dec := &PolicyDecision{
				MaxDurationSec: 0,
			}
			// Re-derive MaxDuration from the template so the grant window
			// honours the cap recorded at request time.
			if req.TemplateID != nil {
				if t, err := s.repo.FindTemplate(ctx, *req.TemplateID); err == nil && t != nil {
					dec.MaxDurationSec = t.MaxDurationSec
				}
			}
			grant, err := s.finalApprove(ctx, req, dec, in.ApproverID, "",
				model.ApprovalReqApproved, "all stages approved", in.DurationSec)
			if err != nil {
				return nil, err
			}
			s.dispatchNotify(ctx, req, model.ApprovalEvRequestApproved, grant)
			out.Grant = grant
			out.FinalStatus = model.ApprovalReqApproved
			return out, nil
		}
		// Advance: bump current_stage + spawn next stage tasks.
		if ok, err := s.repo.AdvanceStage(ctx, req.ID, req.Version, nextStage); err != nil {
			return nil, err
		} else if !ok {
			return nil, errors.New("approval: lost optimistic lock on advance")
		}
		req.CurrentStage = nextStage
		req.Version++
		if _, err := s.engine.SpawnStage(ctx, req, nextStage, *spec); err != nil {
			return nil, fmt.Errorf("approval: spawn stage %d: %w", nextStage, err)
		}
		s.dispatchNotify(ctx, req, model.ApprovalEvTaskCreated, nil)
	}
	return out, nil
}

// loadStage returns (stageSpec, totalStages, error) for the supplied stage
// index. Used both by Decide for advancement and by the reconciler for
// re-spawning on timeout.
func (s *Service) loadStage(ctx context.Context, req *model.ApprovalRequest, stage int) (*StageSpec, int, error) {
	if req.TemplateID == nil {
		return nil, 0, errors.New("approval: request has no template")
	}
	tpl, err := s.repo.FindTemplate(ctx, *req.TemplateID)
	if err != nil {
		return nil, 0, err
	}
	if tpl == nil {
		return nil, 0, errors.New("approval: template missing")
	}
	body, err := parseTemplateBody(tpl)
	if err != nil {
		return nil, 0, err
	}
	if stage >= len(body.Stages) {
		return nil, len(body.Stages), nil
	}
	st := body.Stages[stage]
	if st.TimeoutSec == 0 && tpl.DefaultTimeoutSec > 0 {
		st.TimeoutSec = tpl.DefaultTimeoutSec
	}
	return &st, len(body.Stages), nil
}

// finalApprove issues the grant, marks the request approved/auto-approved,
// and appends ledger events. Shared between Decide's final-stage branch and
// the auto-approve path in CreateRequest.
func (s *Service) finalApprove(ctx context.Context, req *model.ApprovalRequest,
	dec *PolicyDecision, actorID uint64, actorName string,
	finalStatus model.ApprovalRequestStatus, reason string, overrideDurationSec int) (*model.ApprovalGrant, error) {
	// Default: honour the requester's asked-for window, anchored at request
	// creation. When an approver sets an explicit duration, re-anchor at the
	// moment of approval ("从现在起 N 小时") so a late decision still grants the
	// full window. Either way the template cap is the hard ceiling.
	notBefore := req.WindowStart
	notAfter := req.WindowEnd
	if overrideDurationSec > 0 {
		notBefore = s.clock()
		notAfter = notBefore.Add(time.Duration(overrideDurationSec) * time.Second)
	}
	if dec != nil && dec.MaxDurationSec > 0 {
		cap := notBefore.Add(time.Duration(dec.MaxDurationSec) * time.Second)
		if cap.Before(notAfter) {
			notAfter = cap
		}
	}
	g := &model.ApprovalGrant{
		ID:            uuid.NewString(),
		RequestID:     req.ID,
		BusinessType:  req.BusinessType,
		BeneficiaryID: req.RequesterID,
		ResourceType:  req.ResourceType,
		ResourceID:    req.ResourceID,
		Actions:       defaultActionsFor(req.BusinessType),
		MaxUses:       0,
		NotBefore:     notBefore,
		NotAfter:      notAfter,
		Status:        model.ApprovalGrantActive,
		CreatedAt:     s.clock(),
	}
	if err := s.repo.CreateGrant(ctx, g); err != nil {
		return nil, fmt.Errorf("approval: create grant: %w", err)
	}
	if _, err := s.repo.UpdateRequestStatus(ctx, req.ID, req.Version,
		finalStatus, -1, true, &notAfter); err != nil {
		return nil, err
	}
	req.Status = finalStatus
	if finalStatus == model.ApprovalReqAutoApproved {
		_, _ = s.ledger.AppendForRequest(ctx, req.ID, model.ApprovalEvAutoApproved,
			actorID, actorName, map[string]any{"reason": reason, "grant_id": g.ID})
	} else {
		_, _ = s.ledger.AppendForRequest(ctx, req.ID, model.ApprovalEvRequestApproved,
			actorID, actorName, map[string]any{"reason": reason, "grant_id": g.ID})
	}
	_, _ = s.ledger.AppendForRequest(ctx, req.ID, model.ApprovalEvGrantIssued,
		actorID, actorName, map[string]any{
			"grant_id":   g.ID,
			"resource":   g.ResourceType + ":" + g.ResourceID,
			"actions":    g.Actions,
			"not_before": g.NotBefore,
			"not_after":  g.NotAfter,
		})
	return g, nil
}

// defaultActionsFor maps a business type onto the action codes the issued
// grant should carry. This is intentionally simple — admins can override
// per-request via Payload.actions in a later phase.
func defaultActionsFor(bt model.ApprovalBusinessType) string {
	switch bt {
	case model.ApprovalBizAssetAccess, model.ApprovalBizSessionExtend, model.ApprovalBizVendorAccess:
		return "connect"
	case model.ApprovalBizCredentialUse:
		return "credential_use"
	case model.ApprovalBizCommandExec:
		return "exec"
	case model.ApprovalBizSQLExec:
		return "sql_exec"
	case model.ApprovalBizFileTransfer:
		return "sftp_read,sftp_write"
	case model.ApprovalBizSessionElevate:
		return "elevate"
	case model.ApprovalBizBreakGlass:
		return "connect,exec,sftp_read,sftp_write,credential_use"
	case model.ApprovalBizAuditView:
		return "audit_view"
	}
	return "connect"
}

// DecideInput / DecideOutput
type DecideInput struct {
	ApproverID uint64
	Approve    bool
	Comment    string
	// DurationSec, when > 0 and this decision finalises the request, sets the
	// issued grant's window length from WindowStart. It is always clamped to
	// the template's MaxDurationSec — an approver can tighten or extend within
	// the policy cap, never beyond it. Ignored on rejection or non-final stages.
	DurationSec int
}
type DecideOutput struct {
	Request      *model.ApprovalRequest
	Task         *model.ApprovalTask
	StageOutcome StageOutcome
	FinalStatus  model.ApprovalRequestStatus
	Grant        *model.ApprovalGrant
}

// Delegate hands a pending task to another user.
func (s *Service) Delegate(ctx context.Context, taskID, delegateTo uint64, comment string) (*model.ApprovalTask, error) {
	return s.engine.Delegate(ctx, taskID, delegateTo, comment)
}

// Cancel lets the requester abandon a still-pending request.
func (s *Service) Cancel(ctx context.Context, requestID string, by uint64, reason string) error {
	req, err := s.repo.FindRequest(ctx, requestID)
	if err != nil {
		return err
	}
	if req == nil {
		return errors.New("approval: request not found")
	}
	if req.RequesterID != by {
		return errors.New("approval: only the requester may cancel")
	}
	if req.Status != model.ApprovalReqPending {
		return fmt.Errorf("approval: request in state %q cannot be cancelled", req.Status)
	}
	now := s.clock()
	if _, err := s.repo.UpdateRequestStatus(ctx, requestID, req.Version,
		model.ApprovalReqCancelled, -1, true, &now); err != nil {
		return err
	}
	_ = s.repo.SkipRemainingTasks(ctx, requestID, req.CurrentStage)
	_, _ = s.ledger.AppendForRequest(ctx, requestID, model.ApprovalEvRequestCancelled,
		by, "", map[string]any{"reason": reason})
	req.Status = model.ApprovalReqCancelled
	s.dispatchNotify(ctx, req, model.ApprovalEvRequestCancelled, nil)
	return nil
}

// RevokeGrant kills an active grant. Audit:read or approval:admin permitted
// at the handler layer.
func (s *Service) RevokeGrant(ctx context.Context, grantID string, by uint64, reason string) error {
	g, err := s.repo.FindGrant(ctx, grantID)
	if err != nil {
		return err
	}
	if g == nil {
		return errors.New("approval: grant not found")
	}
	if err := s.repo.RevokeGrant(ctx, grantID, by, reason); err != nil {
		return err
	}
	_, _ = s.ledger.AppendForRequest(ctx, g.RequestID, model.ApprovalEvGrantRevoked, by, "",
		map[string]any{"grant_id": grantID, "reason": reason})
	if req, _ := s.repo.FindRequest(ctx, g.RequestID); req != nil {
		s.dispatchNotify(ctx, req, model.ApprovalEvGrantRevoked, g)
	}
	return nil
}

// GrantCheck is the enforcement-point query used by webssh / dbcli / sftp /
// secrets / desktop / portforward. Pass the user, the resource, and the
// action being attempted; the service returns whether an active grant
// covers it.
type GrantCheck struct {
	UserID       uint64
	ResourceType string
	ResourceID   string
	Action       string
	BusinessType model.ApprovalBusinessType
}

// GrantCheckResult reports whether an action is permitted. If Permitted is
// true the GrantID + ExpiresAt come from the most-relevant grant; consume
// callers should pass GrantID back into Increment if they want use-count
// enforcement.
type GrantCheckResult struct {
	Permitted bool
	GrantID   string
	ExpiresAt time.Time
}

// VerifyGrant returns whether the user has a live grant for the requested
// action on the resource. The check is fail-closed (Permitted=false on any
// error). The look-up is by exact (resource_type, resource_id) — wildcard
// or hierarchical resolution belongs in a later phase.
func (s *Service) VerifyGrant(ctx context.Context, chk GrantCheck) (GrantCheckResult, error) {
	now := s.clock()
	grants, err := s.repo.FindActiveGrants(ctx, chk.UserID, chk.ResourceType, chk.ResourceID, now)
	if err != nil {
		return GrantCheckResult{}, err
	}
	for _, g := range grants {
		if chk.BusinessType != "" && g.BusinessType != chk.BusinessType {
			continue
		}
		if chk.Action != "" && !actionCovers(g.Actions, chk.Action) {
			continue
		}
		_, _ = s.ledger.AppendForRequest(ctx, g.RequestID, model.ApprovalEvGrantVerified,
			chk.UserID, "", map[string]any{
				"grant_id": g.ID, "action": chk.Action,
				"resource": chk.ResourceType + ":" + chk.ResourceID,
			})
		return GrantCheckResult{Permitted: true, GrantID: g.ID, ExpiresAt: g.NotAfter}, nil
	}
	return GrantCheckResult{Permitted: false}, nil
}

func actionCovers(grantActions, requested string) bool {
	if grantActions == "" {
		return false
	}
	for _, a := range strings.Split(grantActions, ",") {
		if strings.TrimSpace(a) == requested {
			return true
		}
	}
	return false
}

// ListRequests is a thin pass-through used by the API.
func (s *Service) ListRequests(ctx context.Context, requester uint64, status, bizType string, limit, offset int) ([]model.ApprovalRequest, int64, error) {
	return s.repo.ListRequests(ctx, requester, status, bizType, limit, offset)
}

// PendingForApprover is /tasks/me.
func (s *Service) PendingForApprover(ctx context.Context, approverID uint64, limit int) ([]model.ApprovalTask, error) {
	return s.repo.PendingTasksForApprover(ctx, approverID, limit)
}

// GetRequest returns the request + tasks + events + grant in one shot. Used
// by the detail view.
type RequestDetail struct {
	Request *model.ApprovalRequest `json:"request"`
	Tasks   []model.ApprovalTask   `json:"tasks"`
	Events  []model.ApprovalEvent  `json:"events"`
	Grant   *model.ApprovalGrant   `json:"grant,omitempty"`
}

func (s *Service) GetRequest(ctx context.Context, id string) (*RequestDetail, error) {
	req, err := s.repo.FindRequest(ctx, id)
	if err != nil || req == nil {
		return nil, err
	}
	tasks, err := s.repo.TasksForRequest(ctx, id)
	if err != nil {
		return nil, err
	}
	events, err := s.repo.EventsForRequest(ctx, id)
	if err != nil {
		return nil, err
	}
	grant, _ := s.repo.FindGrantForRequest(ctx, id)
	return &RequestDetail{Request: req, Tasks: tasks, Events: events, Grant: grant}, nil
}

// VerifyChain delegates to the Ledger; exposed on Service so handlers don't
// have to thread the Ledger separately.
func (s *Service) VerifyChain(ctx context.Context, requestID string) (*ChainVerifyResult, error) {
	return s.ledger.VerifyChain(ctx, requestID)
}

// dispatchNotify is best-effort fan-out to subscriptions; it must never
// block the caller. Errors are logged inside the FanoutNotifier.
func (s *Service) dispatchNotify(ctx context.Context, req *model.ApprovalRequest,
	kind model.ApprovalEventKind, grant *model.ApprovalGrant) {
	// In-app realtime fan-out runs first and unconditionally — it is
	// independent of whether any external (IM/webhook) subscriptions exist.
	s.publishHub(ctx, req, kind, grant)
	if s.notifier == nil {
		return
	}
	subs, err := s.repo.ActiveSubscriptionsForBiz(ctx, req.BusinessType)
	if err != nil {
		s.logger.Warn("approval: load subscriptions failed", zap.Error(err))
		return
	}
	if len(subs) == 0 {
		return
	}
	last, _ := s.repo.LastEvent(ctx, req.ID)
	if last == nil {
		return
	}
	env := NotifyEnvelope{
		Event:   *last,
		Request: *req,
	}
	if grant != nil {
		env.GrantID = grant.ID
	}
	s.notifier.Dispatch(ctx, env, subs)
}

// publishHub emits a realtime status snapshot to the in-process Hub. Audience =
// the requester plus every still-pending approver, so the per-user stream
// reaches both sides of the flow.
func (s *Service) publishHub(ctx context.Context, req *model.ApprovalRequest,
	kind model.ApprovalEventKind, grant *model.ApprovalGrant) {
	if s.hub == nil || req == nil {
		return
	}
	audience := []uint64{req.RequesterID}
	if tasks, err := s.repo.TasksForRequest(ctx, req.ID); err == nil {
		for _, t := range tasks {
			if t.State == model.ApprovalTaskPending && t.ApproverID != 0 {
				audience = append(audience, t.ApproverID)
			}
		}
	}
	ev := Event{
		RequestID:    req.ID,
		RequesterID:  req.RequesterID,
		Audience:     audience,
		Kind:         string(kind),
		Status:       string(req.Status),
		Title:        req.Title,
		BusinessType: string(req.BusinessType),
		ResourceType: req.ResourceType,
		ResourceID:   req.ResourceID,
		RiskLevel:    string(req.RiskLevel),
		CurrentStage: req.CurrentStage,
		TotalStages:  req.TotalStages,
		At:           s.clock(),
	}
	if grant != nil {
		ev.GrantID = grant.ID
		ev.ExpiresAt = grant.NotAfter
	}
	s.hub.Publish(ev)
}

// PreflightResult tells the workspace whether a connection may proceed, and if
// not, whether the user already has a pending request to resume.
type PreflightResult struct {
	Required         bool      `json:"required"`
	Allowed          bool      `json:"allowed"`
	GrantID          string    `json:"grant_id,omitempty"`
	ExpiresAt        time.Time `json:"expires_at,omitempty"`
	PendingRequestID string    `json:"pending_request_id,omitempty"`
	Reason           string    `json:"reason,omitempty"`
}

// Preflight is the workspace gate: it runs the same enforcement check the
// gateways do, and surfaces any in-flight request so the UI can resume it
// instead of opening a duplicate.
func (s *Service) Preflight(ctx context.Context, userID uint64, biz model.ApprovalBusinessType, resType, resID, action string) (PreflightResult, error) {
	res, err := s.CheckEnforced(ctx, EnforcementCheck{
		UserID:       userID,
		BusinessType: biz,
		ResourceType: resType,
		ResourceID:   resID,
		Action:       action,
	})
	if err != nil {
		return PreflightResult{}, err
	}
	out := PreflightResult{
		Required:  res.Required,
		Allowed:   res.Allowed,
		GrantID:   res.GrantID,
		ExpiresAt: res.ExpiresAt,
		Reason:    res.Reason,
	}
	if res.Required && !res.Allowed {
		if req, err := s.repo.FindPendingRequestForResource(ctx, userID, resType, resID, biz); err == nil && req != nil {
			out.PendingRequestID = req.ID
		}
	}
	return out, nil
}

// WatchGrant runs the authoritative, renewal-aware server-side cutoff for a live
// session. Starting from initialDeadline it waits; when the window lapses it
// re-checks — a renewed grant (a fresh request approved before expiry, whose
// grant carries a later not_after) reschedules the cutoff so the session is NOT
// dropped; otherwise onExpire fires. Returns a stop func (safe to call once);
// it also stops when ctx is cancelled (session ended). A zero initialDeadline
// means the access wasn't time-bound — returns a no-op.
func (s *Service) WatchGrant(ctx context.Context, chk EnforcementCheck, initialDeadline time.Time, onExpire func(reason string)) func() {
	if initialDeadline.IsZero() || onExpire == nil {
		return func() {}
	}
	done := make(chan struct{})
	var once sync.Once
	stop := func() { once.Do(func() { close(done) }) }

	go func() {
		deadline := initialDeadline
		for {
			wait := time.Until(deadline)
			if wait < 0 {
				wait = 0
			}
			timer := time.NewTimer(wait)
			select {
			case <-ctx.Done():
				timer.Stop()
				return
			case <-done:
				timer.Stop()
				return
			case <-timer.C:
			}
			// Window reached — re-check. A renewal extends `ExpiresAt`.
			res, err := s.CheckEnforced(ctx, chk)
			if err != nil || !res.Allowed || res.ExpiresAt.IsZero() ||
				!res.ExpiresAt.After(deadline.Add(time.Second)) {
				onExpire("approval expired")
				return
			}
			deadline = res.ExpiresAt // renewed → keep the session alive
		}
	}()
	return stop
}

// ----- helpers -----

func isKnownBiz(b model.ApprovalBusinessType) bool {
	switch b {
	case model.ApprovalBizAssetAccess, model.ApprovalBizCredentialUse,
		model.ApprovalBizCommandExec, model.ApprovalBizSQLExec,
		model.ApprovalBizFileTransfer, model.ApprovalBizSessionExtend,
		model.ApprovalBizSessionElevate, model.ApprovalBizBreakGlass,
		model.ApprovalBizVendorAccess, model.ApprovalBizAuditView:
		return true
	}
	return false
}

func truncate(s string, max int) string {
	if len(s) <= max {
		return s
	}
	return s[:max]
}

func jsonString(v map[string]any) string {
	if len(v) == 0 {
		return ""
	}
	b, err := json.Marshal(v)
	if err != nil {
		return ""
	}
	return string(b)
}
