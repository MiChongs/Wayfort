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
