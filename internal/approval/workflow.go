package approval

import (
	"context"
	"errors"
	"fmt"
	"time"

	"github.com/michongs/wayfort/internal/model"
	"github.com/michongs/wayfort/internal/repo"
)

// ApproverLookup resolves role names to concrete user IDs at the moment a
// stage is spawned. This is a one-direction dependency: the workflow never
// imports the auth package. The bootstrap wires a closure backed by
// auth.Resolver + repo.RoleRepo. Returning a nil/empty slice for a role
// causes the engine to skip that stage with a "no_approver_resolved"
// ApprovalEvent and fall through to the next stage; an entirely empty stage
// fails the request closed.
type ApproverLookup func(ctx context.Context, roleName string) ([]uint64, error)

// Engine is the swappable workflow contract. Today the only implementation
// is an in-process state machine (StateMachineEngine). A subsequent phase
// can substitute a Temporal-backed implementation behind this interface
// without changing service.go or the API.
type Engine interface {
	// SpawnStage materialises the tasks for the given stage of an
	// already-existing request and returns the created task rows. Stage
	// index is 0-based.
	SpawnStage(ctx context.Context, req *model.ApprovalRequest, stage int, spec StageSpec) ([]model.ApprovalTask, error)

	// Decide processes a single approver's decision and propagates it
	// (stage completion, request termination, grant issuance is left to
	// the caller). Returns the updated request + the stage outcome.
	Decide(ctx context.Context, taskID uint64, decision Decision) (*DecisionOutcome, error)

	// Delegate hands a pending task to a different user. The original
	// task is marked delegated and a new pending task is spawned for the
	// delegate. Returns the new task.
	Delegate(ctx context.Context, taskID uint64, delegateTo uint64, comment string) (*model.ApprovalTask, error)
}

// Decision is what a single approver hands back.
type Decision struct {
	ApproverID uint64
	Approve    bool
	Comment    string
}

// StageOutcome enumerates the possible terminal states of a stage.
type StageOutcome string

const (
	StageStillRunning StageOutcome = "still_running"
	StageApproved     StageOutcome = "approved"
	StageRejected     StageOutcome = "rejected"
)

// DecisionOutcome reports what the engine did with one decision.
type DecisionOutcome struct {
	RequestID    string
	Stage        int
	StageOutcome StageOutcome
	// FinalRequestStatus is set only when the request itself reached a
	// terminal state on this decision. Otherwise it's the empty string and
	// the caller treats the request as still pending.
	FinalRequestStatus model.ApprovalRequestStatus
}

// StateMachineEngine is the in-process Engine implementation.
type StateMachineEngine struct {
	repo          *repo.ApprovalRepo
	lookup        ApproverLookup
	ledger        *Ledger
	clock         func() time.Time
	adminFallback func(ctx context.Context) ([]uint64, error)
}

// SetAdminFallback supplies the last-resort approver set (system admins) used
// when a stage's configured roles / users resolve to nobody — so a request is
// never wedged just because its approver role is unstaffed. Pass nil to disable.
func (e *StateMachineEngine) SetAdminFallback(fn func(ctx context.Context) ([]uint64, error)) {
	e.adminFallback = fn
}

// NewStateMachineEngine wires the in-process engine. `clock` is injectable
// for tests; pass nil to use time.Now.
func NewStateMachineEngine(r *repo.ApprovalRepo, lookup ApproverLookup, ledger *Ledger) *StateMachineEngine {
	return &StateMachineEngine{
		repo:   r,
		lookup: lookup,
		ledger: ledger,
		clock:  time.Now,
	}
}

// SetClock overrides the engine's clock; used by tests.
func (e *StateMachineEngine) SetClock(fn func() time.Time) {
	if fn != nil {
		e.clock = fn
	}
}

// SpawnStage materialises tasks for the supplied stage. Approvers are the
// union of static UserIDs and role-resolved users. Empty resolution causes
// every role and every user to be checked; if zero approvers remain we
// return an error so the service can fail the request closed.
func (e *StateMachineEngine) SpawnStage(ctx context.Context, req *model.ApprovalRequest,
	stage int, spec StageSpec) ([]model.ApprovalTask, error) {
	if req == nil {
		return nil, errors.New("workflow: nil request")
	}
	approvers := map[uint64]string{}
	for _, uid := range spec.UserIDs {
		if uid > 0 {
			approvers[uid] = ""
		}
	}
	if e.lookup != nil {
		for _, role := range spec.RoleNames {
			uids, err := e.lookup(ctx, role)
			if err != nil {
				return nil, fmt.Errorf("workflow: resolve role %q: %w", role, err)
			}
			for _, uid := range uids {
				// Don't drop role attribution when both static and role
				// resolution include the same user — first writer wins.
				if _, exists := approvers[uid]; !exists {
					approvers[uid] = role
				}
			}
		}
	}
	// Last resort: when the configured roles/users resolve to nobody (e.g. the
	// approver role is unstaffed), route to system admins so the request isn't
	// wedged. Only if there are no admins either do we fail closed.
	if len(approvers) == 0 && e.adminFallback != nil {
		uids, err := e.adminFallback(ctx)
		if err != nil {
			return nil, fmt.Errorf("workflow: admin fallback: %w", err)
		}
		for _, uid := range uids {
			if uid > 0 {
				approvers[uid] = "admin"
			}
		}
	}
	if len(approvers) == 0 {
		return nil, fmt.Errorf("workflow: stage %d has no resolvable approvers", stage)
	}

	now := e.clock()
	var expiresAt *time.Time
	if spec.TimeoutSec > 0 {
		t := now.Add(time.Duration(spec.TimeoutSec) * time.Second)
		expiresAt = &t
	}

	tasks := make([]model.ApprovalTask, 0, len(approvers))
	for uid, role := range approvers {
		tasks = append(tasks, model.ApprovalTask{
			RequestID:    req.ID,
			Stage:        stage,
			StageMode:    spec.Mode,
			QuorumN:      spec.QuorumN,
			ApproverID:   uid,
			ApproverRole: role,
			State:        model.ApprovalTaskPending,
			ExpiresAt:    expiresAt,
			CreatedAt:    now,
		})
	}
	if err := e.repo.CreateTasks(ctx, tasks); err != nil {
		return nil, fmt.Errorf("workflow: persist tasks: %w", err)
	}
	if e.ledger != nil {
		_, _ = e.ledger.AppendForRequest(ctx, req.ID, model.ApprovalEvTaskCreated, 0, "system",
			map[string]any{
				"stage":     stage,
				"mode":      string(spec.Mode),
				"approvers": uidList(approvers),
				"timeout":   spec.TimeoutSec,
				"quorum_n":  spec.QuorumN,
			})
	}
	// Re-read to capture DB-assigned IDs for the caller (gorm batch insert
	// fills back-references in-place but a re-read is cheap and removes
	// any provider-specific surprise around RETURNING).
	return e.repo.TasksForStage(ctx, req.ID, stage)
}

func uidList(m map[uint64]string) []uint64 {
	out := make([]uint64, 0, len(m))
	for k := range m {
		out = append(out, k)
	}
	return out
}

// Decide records a single approver's verdict and computes the stage outcome.
// It does NOT advance the request to the next stage — service.go is
// responsible for spawning the next stage / issuing the grant once Decide
// reports StageApproved on the last stage. Splitting that gives a clean
// place to inject post-decision policy hooks later (compliance check, dual
// approval threshold, …).
func (e *StateMachineEngine) Decide(ctx context.Context, taskID uint64, d Decision) (*DecisionOutcome, error) {
	task, err := e.repo.FindTask(ctx, taskID)
	if err != nil {
		return nil, err
	}
	if task == nil {
		return nil, fmt.Errorf("workflow: task %d not found", taskID)
	}
	if task.State != model.ApprovalTaskPending {
		// Idempotent retry: surface the prior outcome instead of an error.
		return &DecisionOutcome{
			RequestID: task.RequestID,
			Stage:     task.Stage,
			StageOutcome: StageStillRunning,
		}, nil
	}
	if task.ApproverID != d.ApproverID {
		return nil, fmt.Errorf("workflow: task belongs to user %d, not %d", task.ApproverID, d.ApproverID)
	}

	newState := model.ApprovalTaskApproved
	evKind := model.ApprovalEvTaskApproved
	if !d.Approve {
		newState = model.ApprovalTaskRejected
		evKind = model.ApprovalEvTaskRejected
	}
	ok, err := e.repo.UpdateTaskDecision(ctx, taskID, newState, d.Comment, nil)
	if err != nil {
		return nil, err
	}
	if !ok {
		// Another writer beat us; refetch and surface the outcome.
		task, _ = e.repo.FindTask(ctx, taskID)
		if task == nil {
			return nil, fmt.Errorf("workflow: task %d vanished", taskID)
		}
	}
	if e.ledger != nil {
		_, _ = e.ledger.AppendForRequest(ctx, task.RequestID, evKind, d.ApproverID, "",
			map[string]any{"task_id": taskID, "comment": d.Comment, "stage": task.Stage})
	}

	// Recompute stage outcome.
	siblings, err := e.repo.TasksForStage(ctx, task.RequestID, task.Stage)
	if err != nil {
		return nil, err
	}
	outcome := stageOutcomeFor(task.StageMode, task.QuorumN, siblings)

	// If the stage is decided one way or another, skip the remaining
	// pending peers so the dashboard reflects reality and the reconciler
	// doesn't bother with them.
	if outcome != StageStillRunning {
		if err := e.repo.SkipRemainingTasks(ctx, task.RequestID, task.Stage); err != nil {
			return nil, err
		}
	}

	return &DecisionOutcome{
		RequestID:    task.RequestID,
		Stage:        task.Stage,
		StageOutcome: outcome,
	}, nil
}

// stageOutcomeFor implements the three combinator modes:
//
//   any    — first approval wins, first rejection only fails the stage if
//            every other task is also rejected.
//   all    — every task must approve; one rejection fails the stage.
//   quorum — N approvals from M tasks; once approvals ≥ N the stage
//            approves, once rejections > M-N the stage fails.
//
// Tasks in state==skipped count as neither approved nor rejected (the
// caller already decided the stage and is just closing peers).
func stageOutcomeFor(mode model.ApprovalStageMode, quorumN int, tasks []model.ApprovalTask) StageOutcome {
	var approved, rejected, pending int
	for _, t := range tasks {
		switch t.State {
		case model.ApprovalTaskApproved:
			approved++
		case model.ApprovalTaskRejected:
			rejected++
		case model.ApprovalTaskPending, model.ApprovalTaskDelegated:
			pending++
		}
	}
	total := approved + rejected + pending
	if total == 0 {
		return StageStillRunning
	}
	switch mode {
	case model.ApprovalStageAny:
		if approved > 0 {
			return StageApproved
		}
		if pending == 0 {
			return StageRejected
		}
	case model.ApprovalStageAll:
		if rejected > 0 {
			return StageRejected
		}
		if pending == 0 {
			return StageApproved
		}
	case model.ApprovalStageQuorum:
		if quorumN <= 0 {
			quorumN = 1
		}
		if approved >= quorumN {
			return StageApproved
		}
		if rejected > total-quorumN {
			return StageRejected
		}
	}
	return StageStillRunning
}

// Delegate hands the task to another user. We mark the original task
// delegated and spawn a fresh task for the delegate so the ledger trail
// shows both the handoff and the eventual decision.
func (e *StateMachineEngine) Delegate(ctx context.Context, taskID, delegateTo uint64, comment string) (*model.ApprovalTask, error) {
	task, err := e.repo.FindTask(ctx, taskID)
	if err != nil {
		return nil, err
	}
	if task == nil {
		return nil, fmt.Errorf("workflow: task %d not found", taskID)
	}
	if task.State != model.ApprovalTaskPending {
		return nil, fmt.Errorf("workflow: task %d not pending", taskID)
	}
	if delegateTo == task.ApproverID || delegateTo == 0 {
		return nil, errors.New("workflow: invalid delegate target")
	}
	dt := delegateTo
	ok, err := e.repo.UpdateTaskDecision(ctx, taskID, model.ApprovalTaskDelegated, comment, &dt)
	if err != nil {
		return nil, err
	}
	if !ok {
		return nil, errors.New("workflow: task already decided")
	}
	now := e.clock()
	newTask := model.ApprovalTask{
		RequestID:    task.RequestID,
		Stage:        task.Stage,
		StageMode:    task.StageMode,
		QuorumN:      task.QuorumN,
		ApproverID:   delegateTo,
		ApproverRole: task.ApproverRole,
		State:        model.ApprovalTaskPending,
		ExpiresAt:    task.ExpiresAt,
		CreatedAt:    now,
	}
	if err := e.repo.CreateTasks(ctx, []model.ApprovalTask{newTask}); err != nil {
		return nil, err
	}
	if e.ledger != nil {
		_, _ = e.ledger.AppendForRequest(ctx, task.RequestID, model.ApprovalEvTaskDelegated,
			task.ApproverID, "", map[string]any{
				"from_task_id": taskID,
				"to_user_id":   delegateTo,
				"comment":      comment,
			})
	}
	// Re-read to find the freshly-assigned task ID.
	tasks, err := e.repo.TasksForStage(ctx, task.RequestID, task.Stage)
	if err != nil {
		return nil, err
	}
	for i := range tasks {
		t := &tasks[i]
		if t.ApproverID == delegateTo && t.State == model.ApprovalTaskPending && t.CreatedAt.Equal(now) {
			return t, nil
		}
	}
	return nil, nil
}
