package repo

import (
	"context"
	"errors"
	"time"

	"github.com/michongs/jumpserver-anonymous/internal/model"
	"gorm.io/gorm"
)

// ApprovalRepo bundles the five approval-service tables under one type so the
// service layer doesn't need to thread five repo handles around. Each method
// is short; the workflow / ledger / service files in internal/approval/* hold
// the actual coordination logic.
type ApprovalRepo struct {
	db *gorm.DB
}

func NewApprovalRepo(db *gorm.DB) *ApprovalRepo { return &ApprovalRepo{db: db} }

// DB returns the underlying *gorm.DB so the service layer can run multi-row
// transactions (issue grant + close tasks + append ledger event) atomically.
func (r *ApprovalRepo) DB() *gorm.DB { return r.db }

// ----- Request -----

func (r *ApprovalRepo) CreateRequest(ctx context.Context, req *model.ApprovalRequest) error {
	return r.db.WithContext(ctx).Create(req).Error
}

func (r *ApprovalRepo) FindRequest(ctx context.Context, id string) (*model.ApprovalRequest, error) {
	var req model.ApprovalRequest
	err := r.db.WithContext(ctx).First(&req, "id = ?", id).Error
	if errors.Is(err, gorm.ErrRecordNotFound) {
		return nil, nil
	}
	return &req, err
}

// UpdateRequestStatus compare-and-swaps via the optimistic Version counter so
// two reconcilers can't both finalise the same request and double-issue a
// grant. The caller must pre-load .Version into oldVersion.
func (r *ApprovalRepo) UpdateRequestStatus(ctx context.Context, id string, oldVersion uint64,
	status model.ApprovalRequestStatus, stage int, resolved bool,
	effectiveEnd *time.Time) (bool, error) {
	updates := map[string]any{
		"status":        status,
		"current_stage": stage,
		"version":       oldVersion + 1,
		"updated_at":    time.Now(),
	}
	if resolved {
		now := time.Now()
		updates["resolved_at"] = &now
	}
	if effectiveEnd != nil {
		updates["effective_window_end"] = effectiveEnd
	}
	res := r.db.WithContext(ctx).Model(&model.ApprovalRequest{}).
		Where("id = ? AND version = ?", id, oldVersion).
		Updates(updates)
	if res.Error != nil {
		return false, res.Error
	}
	return res.RowsAffected == 1, nil
}

// AdvanceStage bumps current_stage without changing status. Used when a stage
// is fully approved and the next stage's tasks have already been spawned.
func (r *ApprovalRepo) AdvanceStage(ctx context.Context, id string, oldVersion uint64, nextStage int) (bool, error) {
	res := r.db.WithContext(ctx).Model(&model.ApprovalRequest{}).
		Where("id = ? AND version = ?", id, oldVersion).
		Updates(map[string]any{
			"current_stage": nextStage,
			"version":       oldVersion + 1,
			"updated_at":    time.Now(),
		})
	if res.Error != nil {
		return false, res.Error
	}
	return res.RowsAffected == 1, nil
}

// ListRequests filters by requester / status with pagination. Empty
// requester=0 means "any".
func (r *ApprovalRepo) ListRequests(ctx context.Context, requester uint64, status string,
	bizType string, limit, offset int) ([]model.ApprovalRequest, int64, error) {
	q := r.db.WithContext(ctx).Model(&model.ApprovalRequest{})
	if requester > 0 {
		q = q.Where("requester_id = ?", requester)
	}
	if status != "" {
		q = q.Where("status = ?", status)
	}
	if bizType != "" {
		q = q.Where("business_type = ?", bizType)
	}
	var total int64
	if err := q.Count(&total).Error; err != nil {
		return nil, 0, err
	}
	if limit <= 0 || limit > 200 {
		limit = 50
	}
	var out []model.ApprovalRequest
	err := q.Order("created_at DESC").Limit(limit).Offset(offset).Find(&out).Error
	return out, total, err
}

// FindExpired returns active requests past their requested window so the
// reconciler can transition them to "expired" and emit a ledger event.
func (r *ApprovalRepo) FindExpired(ctx context.Context, now time.Time, limit int) ([]model.ApprovalRequest, error) {
	if limit <= 0 {
		limit = 100
	}
	var out []model.ApprovalRequest
	err := r.db.WithContext(ctx).
		Where("status = ? AND window_end < ?", model.ApprovalReqPending, now).
		Limit(limit).Find(&out).Error
	return out, err
}

// ----- Task -----

// CreateTasks inserts the slice atomically so a stage's tasks all show up
// together in a poll. Caller must set RequestID/Stage on every row.
func (r *ApprovalRepo) CreateTasks(ctx context.Context, tasks []model.ApprovalTask) error {
	if len(tasks) == 0 {
		return nil
	}
	return r.db.WithContext(ctx).CreateInBatches(tasks, 100).Error
}

func (r *ApprovalRepo) FindTask(ctx context.Context, id uint64) (*model.ApprovalTask, error) {
	var t model.ApprovalTask
	err := r.db.WithContext(ctx).First(&t, id).Error
	if errors.Is(err, gorm.ErrRecordNotFound) {
		return nil, nil
	}
	return &t, err
}

func (r *ApprovalRepo) TasksForRequest(ctx context.Context, requestID string) ([]model.ApprovalTask, error) {
	var out []model.ApprovalTask
	err := r.db.WithContext(ctx).Where("request_id = ?", requestID).
		Order("stage ASC, id ASC").Find(&out).Error
	return out, err
}

func (r *ApprovalRepo) TasksForStage(ctx context.Context, requestID string, stage int) ([]model.ApprovalTask, error) {
	var out []model.ApprovalTask
	err := r.db.WithContext(ctx).
		Where("request_id = ? AND stage = ?", requestID, stage).
		Order("id ASC").Find(&out).Error
	return out, err
}

// PendingTasksForApprover lists everything the given user can act on right
// now. Used by /approvals/tasks/me.
func (r *ApprovalRepo) PendingTasksForApprover(ctx context.Context, approverID uint64, limit int) ([]model.ApprovalTask, error) {
	if limit <= 0 || limit > 200 {
		limit = 100
	}
	var out []model.ApprovalTask
	err := r.db.WithContext(ctx).
		Where("approver_id = ? AND state = ?", approverID, model.ApprovalTaskPending).
		Order("created_at ASC").Limit(limit).Find(&out).Error
	return out, err
}

// UpdateTaskDecision sets the terminal state on a single task. Returns
// (false, nil) if the task was already decided by someone else (idempotency
// against double-click / dual reconciler).
func (r *ApprovalRepo) UpdateTaskDecision(ctx context.Context, taskID uint64,
	state model.ApprovalTaskState, comment string, delegatedTo *uint64) (bool, error) {
	updates := map[string]any{
		"state":      state,
		"comment":    comment,
		"decided_at": time.Now(),
	}
	if delegatedTo != nil {
		updates["delegated_to"] = delegatedTo
	}
	res := r.db.WithContext(ctx).Model(&model.ApprovalTask{}).
		Where("id = ? AND state = ?", taskID, model.ApprovalTaskPending).
		Updates(updates)
	if res.Error != nil {
		return false, res.Error
	}
	return res.RowsAffected == 1, nil
}

// SkipRemainingTasks closes peer tasks once the stage's outcome is decided
// (for any-mode: first approval skips the rest; for all-mode: first rejection
// short-circuits the rest).
func (r *ApprovalRepo) SkipRemainingTasks(ctx context.Context, requestID string, stage int) error {
	return r.db.WithContext(ctx).Model(&model.ApprovalTask{}).
		Where("request_id = ? AND stage = ? AND state = ?", requestID, stage, model.ApprovalTaskPending).
		Updates(map[string]any{
			"state":      model.ApprovalTaskSkipped,
			"decided_at": time.Now(),
		}).Error
}

// FindOverdueTasks returns pending tasks past their per-task ExpiresAt so the
// reconciler can mark them expired and escalate the request.
func (r *ApprovalRepo) FindOverdueTasks(ctx context.Context, now time.Time, limit int) ([]model.ApprovalTask, error) {
	if limit <= 0 {
		limit = 100
	}
	var out []model.ApprovalTask
	err := r.db.WithContext(ctx).
		Where("state = ? AND expires_at IS NOT NULL AND expires_at < ?",
			model.ApprovalTaskPending, now).
		Limit(limit).Find(&out).Error
	return out, err
}

// ----- Event (ledger) -----

// AppendEvent inserts a single event with the caller-computed PrevHash + Hash
// inside a transaction so the chain stays monotonic. The Ledger in
// internal/approval/ledger.go is the public way to call this; raw use here is
// limited to migrations / forensics.
func (r *ApprovalRepo) AppendEvent(ctx context.Context, ev *model.ApprovalEvent) error {
	return r.db.WithContext(ctx).Create(ev).Error
}

// LastEvent returns the most recent event for a request (by id, which is
// monotonic). nil means the request has no events yet (genesis case).
func (r *ApprovalRepo) LastEvent(ctx context.Context, requestID string) (*model.ApprovalEvent, error) {
	var ev model.ApprovalEvent
	err := r.db.WithContext(ctx).Where("request_id = ?", requestID).
		Order("id DESC").Limit(1).First(&ev).Error
	if errors.Is(err, gorm.ErrRecordNotFound) {
		return nil, nil
	}
	return &ev, err
}

// EventsForRequest returns the full ledger chain for a request, ordered.
func (r *ApprovalRepo) EventsForRequest(ctx context.Context, requestID string) ([]model.ApprovalEvent, error) {
	var out []model.ApprovalEvent
	err := r.db.WithContext(ctx).Where("request_id = ?", requestID).
		Order("id ASC").Find(&out).Error
	return out, err
}

// EventsSince returns events newer than the given id, ordered. Used by
// integration layer fan-out to a SIEM consumer.
func (r *ApprovalRepo) EventsSince(ctx context.Context, lastID uint64, limit int) ([]model.ApprovalEvent, error) {
	if limit <= 0 || limit > 1000 {
		limit = 200
	}
	var out []model.ApprovalEvent
	err := r.db.WithContext(ctx).Where("id > ?", lastID).
		Order("id ASC").Limit(limit).Find(&out).Error
	return out, err
}

// ----- Template -----

func (r *ApprovalRepo) CreateTemplate(ctx context.Context, t *model.ApprovalTemplate) error {
	return r.db.WithContext(ctx).Create(t).Error
}
func (r *ApprovalRepo) UpdateTemplate(ctx context.Context, t *model.ApprovalTemplate) error {
	return r.db.WithContext(ctx).Save(t).Error
}
func (r *ApprovalRepo) DeleteTemplate(ctx context.Context, id uint64) error {
	return r.db.WithContext(ctx).Delete(&model.ApprovalTemplate{}, id).Error
}
func (r *ApprovalRepo) FindTemplate(ctx context.Context, id uint64) (*model.ApprovalTemplate, error) {
	var t model.ApprovalTemplate
	err := r.db.WithContext(ctx).First(&t, id).Error
	if errors.Is(err, gorm.ErrRecordNotFound) {
		return nil, nil
	}
	return &t, err
}
func (r *ApprovalRepo) FindTemplateByName(ctx context.Context, name string) (*model.ApprovalTemplate, error) {
	var t model.ApprovalTemplate
	err := r.db.WithContext(ctx).Where("name = ?", name).First(&t).Error
	if errors.Is(err, gorm.ErrRecordNotFound) {
		return nil, nil
	}
	return &t, err
}

// ListTemplatesForBiz returns enabled templates that target the given
// business type plus any catch-all templates that match every type. Lower
// Priority sorts first.
func (r *ApprovalRepo) ListTemplatesForBiz(ctx context.Context, bizType model.ApprovalBusinessType) ([]model.ApprovalTemplate, error) {
	var out []model.ApprovalTemplate
	err := r.db.WithContext(ctx).
		Where("enabled = ? AND (business_type = ? OR business_type = '')", true, string(bizType)).
		Order("priority ASC, id ASC").Find(&out).Error
	return out, err
}

// ListTemplates returns all templates (admin view).
func (r *ApprovalRepo) ListTemplates(ctx context.Context) ([]model.ApprovalTemplate, error) {
	var out []model.ApprovalTemplate
	err := r.db.WithContext(ctx).Order("priority ASC, id ASC").Find(&out).Error
	return out, err
}

// ----- Grant -----

func (r *ApprovalRepo) CreateGrant(ctx context.Context, g *model.ApprovalGrant) error {
	return r.db.WithContext(ctx).Create(g).Error
}

func (r *ApprovalRepo) FindGrant(ctx context.Context, id string) (*model.ApprovalGrant, error) {
	var g model.ApprovalGrant
	err := r.db.WithContext(ctx).First(&g, "id = ?", id).Error
	if errors.Is(err, gorm.ErrRecordNotFound) {
		return nil, nil
	}
	return &g, err
}

func (r *ApprovalRepo) FindGrantForRequest(ctx context.Context, requestID string) (*model.ApprovalGrant, error) {
	var g model.ApprovalGrant
	err := r.db.WithContext(ctx).Where("request_id = ?", requestID).First(&g).Error
	if errors.Is(err, gorm.ErrRecordNotFound) {
		return nil, nil
	}
	return &g, err
}

// FindActiveGrants returns active grants matching a beneficiary against a
// specific resource. Used by enforcement points to answer "may user U
// perform action A on resource R right now?".
func (r *ApprovalRepo) FindActiveGrants(ctx context.Context, beneficiaryID uint64,
	resourceType, resourceID string, now time.Time) ([]model.ApprovalGrant, error) {
	var out []model.ApprovalGrant
	err := r.db.WithContext(ctx).Where(
		"beneficiary_id = ? AND resource_type = ? AND resource_id = ? AND status = ? AND not_before <= ? AND not_after >= ?",
		beneficiaryID, resourceType, resourceID, model.ApprovalGrantActive, now, now,
	).Find(&out).Error
	return out, err
}

// IncrementGrantUse bumps used_count and flips to used_up when MaxUses>0 and
// the increment would exceed it. Returns (allowed, error). allowed=false
// means the grant is already used up — caller must deny the action.
func (r *ApprovalRepo) IncrementGrantUse(ctx context.Context, id string) (bool, error) {
	allowed := false
	err := r.db.WithContext(ctx).Transaction(func(tx *gorm.DB) error {
		var g model.ApprovalGrant
		if err := tx.Where("id = ?", id).First(&g).Error; err != nil {
			return err
		}
		if g.Status != model.ApprovalGrantActive {
			return nil
		}
		next := g.UsedCount + 1
		updates := map[string]any{"used_count": next}
		if g.MaxUses > 0 && next >= g.MaxUses {
			updates["status"] = model.ApprovalGrantUsedUp
		}
		if err := tx.Model(&model.ApprovalGrant{}).
			Where("id = ?", id).Updates(updates).Error; err != nil {
			return err
		}
		allowed = true
		return nil
	})
	return allowed, err
}

func (r *ApprovalRepo) RevokeGrant(ctx context.Context, id string, by uint64, reason string) error {
	now := time.Now()
	return r.db.WithContext(ctx).Model(&model.ApprovalGrant{}).
		Where("id = ? AND status = ?", id, model.ApprovalGrantActive).
		Updates(map[string]any{
			"status":        model.ApprovalGrantRevoked,
			"revoked_by":    by,
			"revoked_at":    &now,
			"revoke_reason": reason,
		}).Error
}

// ExpireOldGrants flips active grants past their NotAfter to expired. The
// reconciler calls this periodically.
func (r *ApprovalRepo) ExpireOldGrants(ctx context.Context, now time.Time) (int64, error) {
	res := r.db.WithContext(ctx).Model(&model.ApprovalGrant{}).
		Where("status = ? AND not_after < ?", model.ApprovalGrantActive, now).
		Update("status", model.ApprovalGrantExpired)
	return res.RowsAffected, res.Error
}

// ----- Subscription -----

func (r *ApprovalRepo) CreateSubscription(ctx context.Context, s *model.ApprovalSubscription) error {
	return r.db.WithContext(ctx).Create(s).Error
}
func (r *ApprovalRepo) UpdateSubscription(ctx context.Context, s *model.ApprovalSubscription) error {
	return r.db.WithContext(ctx).Save(s).Error
}
func (r *ApprovalRepo) DeleteSubscription(ctx context.Context, id uint64) error {
	return r.db.WithContext(ctx).Delete(&model.ApprovalSubscription{}, id).Error
}
func (r *ApprovalRepo) ListSubscriptions(ctx context.Context) ([]model.ApprovalSubscription, error) {
	var out []model.ApprovalSubscription
	err := r.db.WithContext(ctx).Order("id ASC").Find(&out).Error
	return out, err
}

// ActiveSubscriptionsForBiz returns enabled subscriptions that should
// receive events for the given business type. Empty BusinessType columns
// match every type.
func (r *ApprovalRepo) ActiveSubscriptionsForBiz(ctx context.Context,
	bizType model.ApprovalBusinessType) ([]model.ApprovalSubscription, error) {
	var out []model.ApprovalSubscription
	err := r.db.WithContext(ctx).
		Where("enabled = ? AND (business_type = ? OR business_type = '')", true, string(bizType)).
		Find(&out).Error
	return out, err
}
