package repo

import (
	"context"
	"errors"

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
	Status string
	Limit  int
	Offset int
}

func (r *SessionRepo) List(ctx context.Context, f ListSessionFilter) ([]model.Session, error) {
	q := r.db.WithContext(ctx).Model(&model.Session{})
	if f.UserID != nil {
		q = q.Where("user_id = ?", *f.UserID)
	}
	if f.Status != "" {
		q = q.Where("status = ?", f.Status)
	}
	if f.Limit <= 0 {
		f.Limit = 100
	}
	q = q.Order("started_at DESC").Limit(f.Limit).Offset(f.Offset)
	var out []model.Session
	err := q.Find(&out).Error
	return out, err
}
