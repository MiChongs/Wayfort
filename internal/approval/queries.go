package approval

import (
	"context"
	"time"

	"github.com/michongs/jumpserver-anonymous/internal/model"
	"github.com/michongs/jumpserver-anonymous/internal/repo"
)

// queries.go holds the read-side service methods the redesigned approval
// workspace + governance console call. They are deliberately thin: aggregation
// lives in the repo, business shaping (DTO assembly, batch enrichment) lives
// here, and the API handler just serialises the result.

// Overview is the per-user summary strip at the top of the workspace.
type Overview struct {
	PendingForMe   int64 `json:"pending_for_me"`   // 待我处理：assigned to me, still pending
	MyOpenRequests int64 `json:"my_open_requests"` // 我发起的进行中
	DecidedToday   int64 `json:"decided_today"`    // 今日我已决策（批准 + 驳回）
	ActiveGrants   int64 `json:"active_grants"`    // 我当前持有的有效授权
}

// Overview computes the four workspace counters for one user in parallel-cheap
// individual queries (the tables are indexed on the filtered columns).
func (s *Service) Overview(ctx context.Context, userID uint64) (*Overview, error) {
	now := s.clock()
	ov := &Overview{}
	var err error
	if ov.PendingForMe, err = s.repo.CountPendingTasksForApprover(ctx, userID); err != nil {
		return nil, err
	}
	if ov.MyOpenRequests, err = s.repo.CountRequests(ctx, userID, string(model.ApprovalReqPending)); err != nil {
		return nil, err
	}
	if ov.DecidedToday, err = s.repo.CountTasksDecidedBy(ctx, userID, dayStart(now)); err != nil {
		return nil, err
	}
	if ov.ActiveGrants, err = s.repo.CountActiveGrantsForBeneficiary(ctx, userID, now); err != nil {
		return nil, err
	}
	return ov, nil
}

// RequestSummary is the slice of a request the inbox card needs — enough to
// render the decision context without a second round-trip per task.
type RequestSummary struct {
	ID            string                      `json:"id"`
	BusinessType  model.ApprovalBusinessType  `json:"business_type"`
	Title         string                      `json:"title"`
	Reason        string                      `json:"reason"`
	RequesterID   uint64                      `json:"requester_id"`
	RequesterName string                      `json:"requester_name"`
	ResourceType  string                      `json:"resource_type,omitempty"`
	ResourceID    string                      `json:"resource_id,omitempty"`
	RiskLevel     model.ApprovalRiskLevel     `json:"risk_level"`
	Status        model.ApprovalRequestStatus `json:"status"`
	CurrentStage  int                         `json:"current_stage"`
	TotalStages   int                         `json:"total_stages"`
	WindowEnd     time.Time                   `json:"window_end"`
	CreatedAt     time.Time                   `json:"created_at"`
}

// InboxItem couples a pending task with its parent request so the approver list
// is self-contained — no per-row fetch, no "(加载中)" flicker.
type InboxItem struct {
	Task    model.ApprovalTask `json:"task"`
	Request RequestSummary     `json:"request"`
}

// Inbox returns the approver's pending tasks enriched with parent-request
// context, batch-loading every parent in a single query.
func (s *Service) Inbox(ctx context.Context, approverID uint64, limit int) ([]InboxItem, error) {
	tasks, err := s.repo.PendingTasksForApprover(ctx, approverID, limit)
	if err != nil {
		return nil, err
	}
	if len(tasks) == 0 {
		return []InboxItem{}, nil
	}
	ids := make([]string, 0, len(tasks))
	seen := map[string]bool{}
	for _, t := range tasks {
		if !seen[t.RequestID] {
			seen[t.RequestID] = true
			ids = append(ids, t.RequestID)
		}
	}
	reqs, err := s.repo.RequestsByIDs(ctx, ids)
	if err != nil {
		return nil, err
	}
	byID := make(map[string]model.ApprovalRequest, len(reqs))
	for _, r := range reqs {
		byID[r.ID] = r
	}
	out := make([]InboxItem, 0, len(tasks))
	for _, t := range tasks {
		r, ok := byID[t.RequestID]
		if !ok {
			continue // request vanished (shouldn't happen) — skip rather than render a ghost
		}
		out = append(out, InboxItem{Task: t, Request: summarise(r)})
	}
	return out, nil
}

func summarise(r model.ApprovalRequest) RequestSummary {
	return RequestSummary{
		ID:            r.ID,
		BusinessType:  r.BusinessType,
		Title:         r.Title,
		Reason:        r.Reason,
		RequesterID:   r.RequesterID,
		RequesterName: r.RequesterName,
		ResourceType:  r.ResourceType,
		ResourceID:    r.ResourceID,
		RiskLevel:     r.RiskLevel,
		Status:        r.Status,
		CurrentStage:  r.CurrentStage,
		TotalStages:   r.TotalStages,
		WindowEnd:     r.WindowEnd,
		CreatedAt:     r.CreatedAt,
	}
}

// MyGrants lists a user's grants (active by default, or any of the supplied
// lifecycle states) joined with their originating request + display name.
func (s *Service) MyGrants(ctx context.Context, userID uint64, statuses []string, limit, offset int) ([]repo.GrantRow, int64, error) {
	return s.repo.ListGrants(ctx, userID, statuses, limit, offset)
}

// ListGrants is the governance-console view across every beneficiary.
func (s *Service) ListGrants(ctx context.Context, beneficiaryID uint64, statuses []string, limit, offset int) ([]repo.GrantRow, int64, error) {
	return s.repo.ListGrants(ctx, beneficiaryID, statuses, limit, offset)
}

// Stats is the admin governance snapshot.
func (s *Service) Stats(ctx context.Context) (*repo.StatsSnapshot, error) {
	now := s.clock()
	return s.repo.Stats(ctx, dayStart(now), now)
}

// dayStart returns local midnight for the supplied instant.
func dayStart(t time.Time) time.Time {
	y, m, d := t.Date()
	return time.Date(y, m, d, 0, 0, 0, 0, t.Location())
}
