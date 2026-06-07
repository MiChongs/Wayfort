package repo

import (
	"context"
	"time"

	"github.com/michongs/jumpserver-anonymous/internal/model"
)

// approval_queries.go holds the read-only aggregates and joined look-ups the
// redesigned approval workspace + governance console need. They live apart from
// approval_repo.go (which owns the write path) so the transactional core stays
// easy to audit.

// CountPendingTasksForApprover is the "待我处理" badge: pending tasks owned by
// the user right now.
func (r *ApprovalRepo) CountPendingTasksForApprover(ctx context.Context, approverID uint64) (int64, error) {
	var n int64
	err := r.db.WithContext(ctx).Model(&model.ApprovalTask{}).
		Where("approver_id = ? AND state = ?", approverID, model.ApprovalTaskPending).
		Count(&n).Error
	return n, err
}

// CountRequests counts requests filtered by requester (0 = any) and status
// ("" = any). Backs the "我发起的进行中" overview stat.
func (r *ApprovalRepo) CountRequests(ctx context.Context, requester uint64, status string) (int64, error) {
	q := r.db.WithContext(ctx).Model(&model.ApprovalRequest{})
	if requester > 0 {
		q = q.Where("requester_id = ?", requester)
	}
	if status != "" {
		q = q.Where("status = ?", status)
	}
	var n int64
	err := q.Count(&n).Error
	return n, err
}

// CountTasksDecidedBy counts tasks the user personally resolved (approved or
// rejected) since the given instant — the "今日已决策" overview stat.
func (r *ApprovalRepo) CountTasksDecidedBy(ctx context.Context, approverID uint64, since time.Time) (int64, error) {
	var n int64
	err := r.db.WithContext(ctx).Model(&model.ApprovalTask{}).
		Where("approver_id = ? AND state IN ? AND decided_at >= ?",
			approverID, []model.ApprovalTaskState{model.ApprovalTaskApproved, model.ApprovalTaskRejected}, since).
		Count(&n).Error
	return n, err
}

// CountActiveGrantsForBeneficiary counts a user's live grants — the "我的有效
// 授权" overview stat.
func (r *ApprovalRepo) CountActiveGrantsForBeneficiary(ctx context.Context, uid uint64, now time.Time) (int64, error) {
	var n int64
	err := r.db.WithContext(ctx).Model(&model.ApprovalGrant{}).
		Where("beneficiary_id = ? AND status = ? AND not_after >= ?", uid, model.ApprovalGrantActive, now).
		Count(&n).Error
	return n, err
}

// RequestsByIDs batch-loads requests for the inbox enrichment so the approver
// list resolves every parent in one round-trip instead of N+1.
func (r *ApprovalRepo) RequestsByIDs(ctx context.Context, ids []string) ([]model.ApprovalRequest, error) {
	if len(ids) == 0 {
		return nil, nil
	}
	var out []model.ApprovalRequest
	err := r.db.WithContext(ctx).Where("id IN ?", ids).Find(&out).Error
	return out, err
}

// GrantRow is an issued grant joined with the human-facing context the UI
// needs: the originating request's title/reason and the beneficiary's display
// name (so the governance console doesn't render bare numeric IDs).
type GrantRow struct {
	model.ApprovalGrant
	RequestTitle    string `json:"request_title"`
	RequestReason   string `json:"request_reason"`
	BeneficiaryName string `json:"beneficiary_name"`
}

// ListGrants returns grants joined with request + user context. beneficiaryID=0
// means "all beneficiaries" (governance console); a non-zero value scopes to
// one user ("我的授权"). statuses filters by grant lifecycle state; empty =
// active only. Ordered newest-issued first.
func (r *ApprovalRepo) ListGrants(ctx context.Context, beneficiaryID uint64,
	statuses []string, limit, offset int) ([]GrantRow, int64, error) {
	if len(statuses) == 0 {
		statuses = []string{string(model.ApprovalGrantActive)}
	}
	base := r.db.WithContext(ctx).Table("approval_grants AS g").
		Where("g.status IN ?", statuses)
	if beneficiaryID > 0 {
		base = base.Where("g.beneficiary_id = ?", beneficiaryID)
	}
	// Count first (no Select/Joins set yet → a clean COUNT(*)), then reuse the
	// same conditions for the joined page read — mirrors ListRequests.
	var total int64
	if err := base.Count(&total).Error; err != nil {
		return nil, 0, err
	}
	if limit <= 0 || limit > 200 {
		limit = 100
	}
	var out []GrantRow
	err := base.
		Select("g.*, r.title AS request_title, r.reason AS request_reason, u.display_name AS beneficiary_name").
		Joins("LEFT JOIN approval_requests AS r ON r.id = g.request_id").
		Joins("LEFT JOIN users AS u ON u.id = g.beneficiary_id").
		Order("g.created_at DESC").Limit(limit).Offset(offset).
		Scan(&out).Error
	return out, total, err
}

// StatsSnapshot is the admin governance overview: status distribution, today's
// throughput, and the mean decision latency.
type StatsSnapshot struct {
	StatusCounts   map[string]int64 `json:"status_counts"`
	RiskCounts     map[string]int64 `json:"risk_counts"`
	BusinessCounts map[string]int64 `json:"business_counts"`
	PendingTotal   int64            `json:"pending_total"`
	CreatedToday   int64            `json:"created_today"`
	ResolvedToday  int64            `json:"resolved_today"`
	ActiveGrants   int64            `json:"active_grants"`
	AvgDecisionMin float64          `json:"avg_decision_min"`
}

// Stats computes the governance snapshot. `dayStart` is the caller-supplied
// midnight boundary (keeps the timezone decision in the service / clock).
func (r *ApprovalRepo) Stats(ctx context.Context, dayStart, now time.Time) (*StatsSnapshot, error) {
	snap := &StatsSnapshot{
		StatusCounts:   map[string]int64{},
		RiskCounts:     map[string]int64{},
		BusinessCounts: map[string]int64{},
	}
	type kv struct {
		K string
		N int64
	}
	scan := func(col string, dst map[string]int64) error {
		var rows []kv
		if err := r.db.WithContext(ctx).Model(&model.ApprovalRequest{}).
			Select(col + " AS k, COUNT(*) AS n").Group(col).Scan(&rows).Error; err != nil {
			return err
		}
		for _, row := range rows {
			dst[row.K] = row.N
		}
		return nil
	}
	if err := scan("status", snap.StatusCounts); err != nil {
		return nil, err
	}
	if err := scan("risk_level", snap.RiskCounts); err != nil {
		return nil, err
	}
	if err := scan("business_type", snap.BusinessCounts); err != nil {
		return nil, err
	}
	snap.PendingTotal = snap.StatusCounts[string(model.ApprovalReqPending)]

	if err := r.db.WithContext(ctx).Model(&model.ApprovalRequest{}).
		Where("created_at >= ?", dayStart).Count(&snap.CreatedToday).Error; err != nil {
		return nil, err
	}
	if err := r.db.WithContext(ctx).Model(&model.ApprovalRequest{}).
		Where("resolved_at >= ?", dayStart).Count(&snap.ResolvedToday).Error; err != nil {
		return nil, err
	}
	if err := r.db.WithContext(ctx).Model(&model.ApprovalGrant{}).
		Where("status = ? AND not_after >= ?", model.ApprovalGrantActive, now).
		Count(&snap.ActiveGrants).Error; err != nil {
		return nil, err
	}

	// Mean decision latency over resolved requests: resolved_at - created_at,
	// in minutes. Computed in Go from a bounded recent window to stay portable
	// across PostgreSQL / MySQL without dialect-specific date math.
	type span struct {
		CreatedAt  time.Time
		ResolvedAt *time.Time
	}
	var spans []span
	if err := r.db.WithContext(ctx).Model(&model.ApprovalRequest{}).
		Select("created_at, resolved_at").
		Where("resolved_at IS NOT NULL").
		Order("resolved_at DESC").Limit(500).Scan(&spans).Error; err != nil {
		return nil, err
	}
	if len(spans) > 0 {
		var totalMin float64
		var counted int
		for _, s := range spans {
			if s.ResolvedAt == nil {
				continue
			}
			d := s.ResolvedAt.Sub(s.CreatedAt).Minutes()
			if d < 0 {
				continue
			}
			totalMin += d
			counted++
		}
		if counted > 0 {
			snap.AvgDecisionMin = totalMin / float64(counted)
		}
	}
	return snap, nil
}
