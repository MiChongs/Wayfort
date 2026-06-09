package repo

import (
	"context"
	"errors"
	"time"

	"github.com/michongs/jumpserver-anonymous/internal/model"
	"gorm.io/gorm"
)

type SessionRepo struct{ db *gorm.DB }

func NewSessionRepo(db *gorm.DB) *SessionRepo { return &SessionRepo{db: db} }

func (r *SessionRepo) Create(ctx context.Context, s *model.Session) error {
	return r.db.WithContext(ctx).Create(s).Error
}

func (r *SessionRepo) Update(ctx context.Context, s *model.Session) error {
	return r.db.WithContext(ctx).Save(s).Error
}

func (r *SessionRepo) FindByID(ctx context.Context, id string) (*model.Session, error) {
	var s model.Session
	err := r.db.WithContext(ctx).First(&s, "id = ?", id).Error
	if errors.Is(err, gorm.ErrRecordNotFound) {
		return nil, nil
	}
	return &s, err
}

// UpdateCurrentPhase patches only the sessions.current_phase column. It uses a
// scoped Updates(map) rather than Save so it never clobbers byte/RTT counters a
// concurrent writer may have advanced.
func (r *SessionRepo) UpdateCurrentPhase(ctx context.Context, sessionID string, phase model.SessionPhaseKind) error {
	return r.db.WithContext(ctx).Model(&model.Session{}).
		Where("id = ?", sessionID).
		Update("current_phase", phase).Error
}

// SetReadyAt stamps sessions.ready_at the first time a session reaches ready, so
// ready_at-started_at is the time-to-interactive. Subsequent calls are no-ops
// (only patches rows where ready_at is still null).
func (r *SessionRepo) SetReadyAt(ctx context.Context, sessionID string, at time.Time) error {
	return r.db.WithContext(ctx).Model(&model.Session{}).
		Where("id = ? AND ready_at IS NULL", sessionID).
		Update("ready_at", at).Error
}

// ----- session phases (lifecycle v3) -----

// AppendPhase inserts a new phase row, assigning seq = MAX(seq)+1 for the
// session inside a transaction so concurrent appends can't collide on seq. The
// supplied row's Seq/ID are populated on return.
func (r *SessionRepo) AppendPhase(ctx context.Context, p *model.SessionPhase) error {
	return r.db.WithContext(ctx).Transaction(func(tx *gorm.DB) error {
		var maxSeq uint32
		if err := tx.Model(&model.SessionPhase{}).
			Where("session_id = ?", p.SessionID).
			Select("COALESCE(MAX(seq), 0)").Scan(&maxSeq).Error; err != nil {
			return err
		}
		p.Seq = maxSeq + 1
		return tx.Create(p).Error
	})
}

// ClosePhase finalises the most recent still-running phase of the given kind:
// it backfills ended_at, duration_ms, status, and detail. A no-op (nil) when no
// matching running phase exists.
func (r *SessionRepo) ClosePhase(ctx context.Context, sessionID string, phase model.SessionPhaseKind, status model.PhaseStatus, detail string, at time.Time) error {
	var row model.SessionPhase
	err := r.db.WithContext(ctx).
		Where("session_id = ? AND phase = ? AND status = ?", sessionID, phase, model.PhaseRunning).
		Order("seq DESC").First(&row).Error
	if errors.Is(err, gorm.ErrRecordNotFound) {
		return nil
	}
	if err != nil {
		return err
	}
	dur := at.Sub(row.StartedAt).Milliseconds()
	updates := map[string]any{
		"ended_at":    at,
		"duration_ms": dur,
		"status":      status,
	}
	if detail != "" {
		updates["detail"] = truncatePhase(detail)
	}
	return r.db.WithContext(ctx).Model(&model.SessionPhase{}).
		Where("id = ?", row.ID).Updates(updates).Error
}

// Phases returns every phase of a session ordered by seq (the timeline).
func (r *SessionRepo) Phases(ctx context.Context, sessionID string) ([]model.SessionPhase, error) {
	var out []model.SessionPhase
	err := r.db.WithContext(ctx).
		Where("session_id = ?", sessionID).
		Order("seq ASC").Find(&out).Error
	return out, err
}

// ClosePhaseAny finalises every still-running phase of a session (typically the
// single `ready` phase) — used at teardown so no phase is left dangling.
func (r *SessionRepo) ClosePhaseAny(ctx context.Context, sessionID string, status model.PhaseStatus, at time.Time) error {
	var rows []model.SessionPhase
	if err := r.db.WithContext(ctx).
		Where("session_id = ? AND status = ?", sessionID, model.PhaseRunning).
		Find(&rows).Error; err != nil {
		return err
	}
	for _, row := range rows {
		dur := at.Sub(row.StartedAt).Milliseconds()
		if err := r.db.WithContext(ctx).Model(&model.SessionPhase{}).
			Where("id = ?", row.ID).
			Updates(map[string]any{"ended_at": at, "duration_ms": dur, "status": status}).Error; err != nil {
			return err
		}
	}
	return nil
}

// Finish patches a session row with a column→value map (partial update). Used at
// teardown so the end fields land without a full Save that would clobber columns
// (ready_at, current_phase) a concurrent/earlier partial update advanced.
func (r *SessionRepo) Finish(ctx context.Context, sessionID string, updates map[string]any) error {
	if len(updates) == 0 {
		return nil
	}
	return r.db.WithContext(ctx).Model(&model.Session{}).
		Where("id = ?", sessionID).Updates(updates).Error
}

func truncatePhase(s string) string {
	if len(s) > 512 {
		return s[:512]
	}
	return s
}

// ----- connection-quality samples (lifecycle v3) -----

// AppendMetrics batch-inserts quality samples (called by the MetricWriter
// queue). No-op on an empty slice.
func (r *SessionRepo) AppendMetrics(ctx context.Context, samples []model.SessionMetricSample) error {
	if len(samples) == 0 {
		return nil
	}
	return r.db.WithContext(ctx).CreateInBatches(samples, 128).Error
}

// Metrics returns samples for a session within [from, to] (either may be nil),
// oldest-first, capped at limit (default 2000).
func (r *SessionRepo) Metrics(ctx context.Context, sessionID string, from, to *time.Time, limit int) ([]model.SessionMetricSample, error) {
	if limit <= 0 || limit > 5000 {
		limit = 2000
	}
	q := r.db.WithContext(ctx).Model(&model.SessionMetricSample{}).Where("session_id = ?", sessionID)
	if from != nil {
		q = q.Where("at >= ?", *from)
	}
	if to != nil {
		q = q.Where("at <= ?", *to)
	}
	var out []model.SessionMetricSample
	err := q.Order("at ASC").Limit(limit).Find(&out).Error
	return out, err
}

// MetricSummary reduces a session's samples to peak/avg RTT and total
// reconnects. The reduction happens in Go (pluck the columns, fold here) so the
// query stays dialect-agnostic, mirroring Stats. avgRTT ignores zero readings
// (graphical/forward samples with no RTT) so it reflects real latency.
func (r *SessionRepo) MetricSummary(ctx context.Context, sessionID string) (peakRTT, avgRTT, reconnects uint32, err error) {
	type row struct {
		RTTMs      uint32
		Reconnects uint32
	}
	var rows []row
	if err = r.db.WithContext(ctx).Model(&model.SessionMetricSample{}).
		Select("rtt_ms, reconnects").Where("session_id = ?", sessionID).
		Scan(&rows).Error; err != nil {
		return 0, 0, 0, err
	}
	var sum, nonZero uint64
	for _, rr := range rows {
		if rr.RTTMs > peakRTT {
			peakRTT = rr.RTTMs
		}
		if rr.RTTMs > 0 {
			sum += uint64(rr.RTTMs)
			nonZero++
		}
		reconnects += rr.Reconnects
	}
	if nonZero > 0 {
		avgRTT = uint32(sum / nonZero)
	}
	return peakRTT, avgRTT, reconnects, nil
}

type ListSessionFilter struct {
	UserID *uint64
	NodeID *uint64 // populated by the workspace's per-node "recent sessions" tab
	Status string
	Kind   string
	// Q matches (case-insensitively, substring) against id, node_name,
	// username, and client_ip so the table search box is a single field.
	Q string
	// From/To bound started_at. Either may be nil for an open-ended range.
	From   *time.Time
	To     *time.Time
	Limit  int
	Offset int
}

// scope applies every predicate from the filter to a base query. List and
// Count share it so the row page and the total always agree.
func (r *SessionRepo) scope(ctx context.Context, f ListSessionFilter) *gorm.DB {
	q := r.db.WithContext(ctx).Model(&model.Session{})
	if f.UserID != nil {
		q = q.Where("user_id = ?", *f.UserID)
	}
	if f.NodeID != nil {
		q = q.Where("node_id = ?", *f.NodeID)
	}
	if f.Status != "" {
		q = q.Where("status = ?", f.Status)
	}
	if f.Kind != "" {
		q = q.Where("kind = ?", f.Kind)
	}
	if f.From != nil {
		q = q.Where("started_at >= ?", *f.From)
	}
	if f.To != nil {
		q = q.Where("started_at <= ?", *f.To)
	}
	if f.Q != "" {
		like := "%" + f.Q + "%"
		q = q.Where(
			"id LIKE ? OR node_name LIKE ? OR username LIKE ? OR client_ip LIKE ?",
			like, like, like, like,
		)
	}
	return q
}

func (r *SessionRepo) List(ctx context.Context, f ListSessionFilter) ([]model.Session, error) {
	if f.Limit <= 0 {
		f.Limit = 100
	}
	q := r.scope(ctx, f).Order("started_at DESC").Limit(f.Limit).Offset(f.Offset)
	var out []model.Session
	err := q.Find(&out).Error
	return out, err
}

// Count returns how many rows match the filter ignoring limit/offset.
func (r *SessionRepo) Count(ctx context.Context, f ListSessionFilter) (int64, error) {
	var n int64
	err := r.scope(ctx, f).Count(&n).Error
	return n, err
}

// SessionStats is the overview surface for the sessions audit page.
type SessionStats struct {
	Total    int64             `json:"total"`
	Active   int64             `json:"active"`
	Today    int64             `json:"today"`
	Recorded int64             `json:"recorded"`
	ByKind   []SessionKeyCount `json:"by_kind"`
	ByStatus []SessionKeyCount `json:"by_status"`
	Trend    []SessionDayCount `json:"trend"`
}

type SessionKeyCount struct {
	Key   string `json:"key"`
	Count int64  `json:"count"`
}

type SessionDayCount struct {
	Date  string `json:"date"`
	Count int64  `json:"count"`
}

// Stats aggregates the overview numbers in a handful of cheap queries. The
// trend is bucketed in Go so it stays dialect-agnostic across sqlite / MySQL /
// Postgres.
func (r *SessionRepo) Stats(ctx context.Context, trendDays int) (*SessionStats, error) {
	if trendDays <= 0 {
		trendDays = 14
	}
	out := &SessionStats{}

	if err := r.db.WithContext(ctx).Model(&model.Session{}).Count(&out.Total).Error; err != nil {
		return nil, err
	}
	if err := r.db.WithContext(ctx).Model(&model.Session{}).
		Where("status = ?", model.SessionActive).Count(&out.Active).Error; err != nil {
		return nil, err
	}
	now := time.Now()
	localMidnight := time.Date(now.Year(), now.Month(), now.Day(), 0, 0, 0, 0, now.Location())
	if err := r.db.WithContext(ctx).Model(&model.Session{}).
		Where("started_at >= ?", localMidnight).Count(&out.Today).Error; err != nil {
		return nil, err
	}
	if err := r.db.WithContext(ctx).Model(&model.Session{}).
		Where("cast_path <> ''").Count(&out.Recorded).Error; err != nil {
		return nil, err
	}

	type kc struct {
		K string
		C int64
	}
	var kinds []kc
	if err := r.db.WithContext(ctx).Model(&model.Session{}).
		Select("kind as k, count(*) as c").Group("kind").Scan(&kinds).Error; err != nil {
		return nil, err
	}
	for _, row := range kinds {
		out.ByKind = append(out.ByKind, SessionKeyCount{Key: row.K, Count: row.C})
	}
	var statuses []kc
	if err := r.db.WithContext(ctx).Model(&model.Session{}).
		Select("status as k, count(*) as c").Group("status").Scan(&statuses).Error; err != nil {
		return nil, err
	}
	for _, row := range statuses {
		out.ByStatus = append(out.ByStatus, SessionKeyCount{Key: row.K, Count: row.C})
	}

	since := localMidnight.AddDate(0, 0, -(trendDays - 1))
	var stamps []time.Time
	if err := r.db.WithContext(ctx).Model(&model.Session{}).
		Where("started_at >= ?", since).Pluck("started_at", &stamps).Error; err != nil {
		return nil, err
	}
	buckets := map[string]int64{}
	for _, t := range stamps {
		buckets[t.In(now.Location()).Format("2006-01-02")]++
	}
	for i := 0; i < trendDays; i++ {
		d := since.AddDate(0, 0, i).Format("2006-01-02")
		out.Trend = append(out.Trend, SessionDayCount{Date: d, Count: buckets[d]})
	}

	return out, nil
}
