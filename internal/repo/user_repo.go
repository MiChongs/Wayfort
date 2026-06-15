package repo

import (
	"context"
	"errors"
	"time"

	"github.com/michongs/jumpserver-anonymous/internal/model"
	"gorm.io/gorm"
)

type UserRepo struct{ db *gorm.DB }

func NewUserRepo(db *gorm.DB) *UserRepo { return &UserRepo{db: db} }

// ListByPermissionCodes returns the active (non-disabled) users who can receive
// security alerts: the legacy is_admin bootstrap accounts plus anyone whose
// roles grant any of the given permission codes. Used to resolve "the security
// team" as notification recipients (e.g. security:manage / audit:read /
// system:admin holders). Results are de-duplicated by the SQL DISTINCT on id.
func (r *UserRepo) ListByPermissionCodes(ctx context.Context, codes []string) ([]model.User, error) {
	q := r.db.WithContext(ctx).Model(&model.User{}).Where("disabled = ?", false)
	if len(codes) == 0 {
		q = q.Where("is_admin = ?", true)
	} else {
		sub := r.db.Model(&model.UserRole{}).
			Select("user_roles.user_id").
			Joins("JOIN role_permissions ON role_permissions.role_id = user_roles.role_id").
			Where("role_permissions.permission_code IN ?", codes)
		q = q.Where("is_admin = ? OR id IN (?)", true, sub)
	}
	var out []model.User
	err := q.Order("id").Find(&out).Error
	return out, err
}

func (r *UserRepo) FindByUsername(ctx context.Context, username string) (*model.User, error) {
	var u model.User
	err := r.db.WithContext(ctx).Where("username = ?", username).First(&u).Error
	if errors.Is(err, gorm.ErrRecordNotFound) {
		return nil, nil
	}
	return &u, err
}

func (r *UserRepo) FindByEmail(ctx context.Context, email string) (*model.User, error) {
	var u model.User
	err := r.db.WithContext(ctx).Where("email = ?", email).First(&u).Error
	if errors.Is(err, gorm.ErrRecordNotFound) {
		return nil, nil
	}
	return &u, err
}

func (r *UserRepo) FindByID(ctx context.Context, id uint64) (*model.User, error) {
	var u model.User
	err := r.db.WithContext(ctx).First(&u, id).Error
	if errors.Is(err, gorm.ErrRecordNotFound) {
		return nil, nil
	}
	return &u, err
}

func (r *UserRepo) Create(ctx context.Context, u *model.User) error {
	return r.db.WithContext(ctx).Create(u).Error
}

func (r *UserRepo) Update(ctx context.Context, u *model.User) error {
	return r.db.WithContext(ctx).Save(u).Error
}

func (r *UserRepo) Delete(ctx context.Context, id uint64) error {
	return r.db.WithContext(ctx).Transaction(func(tx *gorm.DB) error {
		// Cascade clean joined tables.
		if err := tx.Where("user_id = ?", id).Delete(&model.UserRole{}).Error; err != nil {
			return err
		}
		if err := tx.Where("user_id = ?", id).Delete(&model.UserGroupMember{}).Error; err != nil {
			return err
		}
		if err := tx.Where("user_id = ?", id).Delete(&model.UserDepartment{}).Error; err != nil {
			return err
		}
		if err := tx.Where("user_id = ?", id).Delete(&model.UserMFA{}).Error; err != nil {
			return err
		}
		if err := tx.Where("user_id = ?", id).Delete(&model.UserRecoveryCode{}).Error; err != nil {
			return err
		}
		if err := tx.Where("user_id = ?", id).Delete(&model.WebauthnCredential{}).Error; err != nil {
			return err
		}
		if err := tx.Where("user_id = ?", id).Delete(&model.NodeFavorite{}).Error; err != nil {
			return err
		}
		if err := tx.Where("user_id = ?", id).Delete(&model.NodeRecent{}).Error; err != nil {
			return err
		}
		return tx.Delete(&model.User{}, id).Error
	})
}

type UserFilter struct {
	Search       string
	DepartmentID *uint64
	Disabled     *bool
	Status       string     // "" = 不限；"active" 自动含历史空串/NULL
	RoleID       *uint64
	TagID        *uint64
	MFAEnforced  *bool
	ActiveSince  *time.Time // 仅含 last_login_at >= ActiveSince（"最近活跃"）
	Sort         string     // "username"(默认) | "created" | "login"
	Desc         bool
	Limit        int
	Offset       int
}

// List returns a filtered, sorted page of users plus the total row count that
// matches the filter (before pagination) so the UI can render real page counts.
func (r *UserRepo) List(ctx context.Context, f UserFilter) ([]model.User, int64, error) {
	q := r.db.WithContext(ctx).Model(&model.User{})
	if f.Search != "" {
		s := "%" + f.Search + "%"
		q = q.Where("username LIKE ? OR display_name LIKE ? OR email LIKE ?", s, s, s)
	}
	if f.DepartmentID != nil {
		// Match any membership (multi-department), not just the primary pointer.
		q = q.Where("id IN (?)",
			r.db.Model(&model.UserDepartment{}).
				Select("user_id").Where("department_id = ?", *f.DepartmentID))
	}
	if f.RoleID != nil {
		q = q.Where("id IN (?)",
			r.db.Model(&model.UserRole{}).Select("user_id").Where("role_id = ?", *f.RoleID))
	}
	if f.TagID != nil {
		q = q.Where("id IN (?)",
			r.db.Model(&model.UserTag{}).Select("user_id").Where("tag_id = ?", *f.TagID))
	}
	if f.Disabled != nil {
		q = q.Where("disabled = ?", *f.Disabled)
	}
	if f.Status != "" {
		if f.Status == model.UserStatusActive {
			q = q.Where("status = ? OR status = '' OR status IS NULL", model.UserStatusActive)
		} else {
			q = q.Where("status = ?", f.Status)
		}
	}
	if f.MFAEnforced != nil {
		q = q.Where("mfa_enforced = ?", *f.MFAEnforced)
	}
	if f.ActiveSince != nil {
		q = q.Where("last_login_at IS NOT NULL AND last_login_at >= ?", *f.ActiveSince)
	}

	var total int64
	if err := q.Count(&total).Error; err != nil {
		return nil, 0, err
	}

	dir := "ASC"
	if f.Desc {
		dir = "DESC"
	}
	switch f.Sort {
	case "created":
		q = q.Order("created_at " + dir).Order("id " + dir)
	case "login":
		// Never-logged-in rows (NULL) always sink to the bottom so the
		// "recently active" view stays meaningful in either direction. Leading
		// with "col IS NULL" keeps this dialect-agnostic (NULLS LAST is PG-only).
		q = q.Order("last_login_at IS NULL").Order("last_login_at " + dir).Order("username ASC")
	default:
		q = q.Order("username " + dir)
	}
	if f.Limit <= 0 {
		f.Limit = 50
	}
	q = q.Limit(f.Limit).Offset(f.Offset)
	var out []model.User
	err := q.Find(&out).Error
	return out, total, err
}

// RecordLoginSuccess updates the user's last login fingerprint.
func (r *UserRepo) RecordLoginSuccess(ctx context.Context, id uint64, ip, ua string) error {
	now := time.Now()
	return r.db.WithContext(ctx).Model(&model.User{}).
		Where("id = ?", id).
		Updates(map[string]any{
			"last_login_at":   &now,
			"last_login_ip":   ip,
			"last_user_agent": ua,
			"locked_until":    nil,
		}).Error
}

func (r *UserRepo) SetLockedUntil(ctx context.Context, id uint64, until *time.Time) error {
	return r.db.WithContext(ctx).Model(&model.User{}).
		Where("id = ?", id).
		Update("locked_until", until).Error
}

func (r *UserRepo) UpdatePassword(ctx context.Context, id uint64, hash string) error {
	now := time.Now()
	return r.db.WithContext(ctx).Model(&model.User{}).
		Where("id = ?", id).
		Updates(map[string]any{"password_hash": hash, "password_changed": &now}).Error
}

// UserTrendPoint is one day on the "new users" sparkline.
type UserTrendPoint struct {
	Date  string `json:"date"`
	Count int64  `json:"count"`
}

// UserStats is the overview-strip payload: headline counts + a daily new-user
// trend. "Active" mirrors User.IsActive (not disabled / suspended / departed /
// expired) so the number matches what the login gate actually lets in.
type UserStats struct {
	Total    int64            `json:"total"`
	Active   int64            `json:"active"`
	Disabled int64            `json:"disabled"`
	Admin    int64            `json:"admin"`
	Locked   int64            `json:"locked"`
	Expired  int64            `json:"expired"`
	Recent7d int64            `json:"recent_7d"`
	Trend    []UserTrendPoint `json:"trend"`
}

func (r *UserRepo) Stats(ctx context.Context, trendDays int) (*UserStats, error) {
	if trendDays <= 0 {
		trendDays = 14
	}
	now := time.Now()
	db := r.db.WithContext(ctx)
	count := func(scope func(*gorm.DB) *gorm.DB) int64 {
		var n int64
		q := db.Model(&model.User{})
		if scope != nil {
			q = scope(q)
		}
		q.Count(&n)
		return n
	}
	s := &UserStats{}
	s.Total = count(nil)
	s.Disabled = count(func(q *gorm.DB) *gorm.DB { return q.Where("disabled = ?", true) })
	s.Admin = count(func(q *gorm.DB) *gorm.DB { return q.Where("is_admin = ?", true) })
	s.Locked = count(func(q *gorm.DB) *gorm.DB { return q.Where("locked_until IS NOT NULL AND locked_until > ?", now) })
	s.Expired = count(func(q *gorm.DB) *gorm.DB { return q.Where("expires_at IS NOT NULL AND expires_at <= ?", now) })
	s.Recent7d = count(func(q *gorm.DB) *gorm.DB {
		return q.Where("last_login_at IS NOT NULL AND last_login_at >= ?", now.AddDate(0, 0, -7))
	})
	s.Active = count(func(q *gorm.DB) *gorm.DB {
		return q.Where("disabled = ? AND (status = ? OR status = '' OR status IS NULL) AND (expires_at IS NULL OR expires_at > ?)",
			false, model.UserStatusActive, now)
	})

	// Daily new-user buckets for the last trendDays days, zero-filled. Bucketed
	// in Go (mirroring SessionRepo.Stats) so it stays dialect-agnostic across
	// sqlite / MySQL / Postgres — no date_trunc / strftime branching.
	localMidnight := time.Date(now.Year(), now.Month(), now.Day(), 0, 0, 0, 0, now.Location())
	since := localMidnight.AddDate(0, 0, -(trendDays - 1))
	var stamps []time.Time
	if err := db.Model(&model.User{}).
		Where("created_at >= ?", since).Pluck("created_at", &stamps).Error; err != nil {
		return nil, err
	}
	buckets := map[string]int64{}
	for _, t := range stamps {
		buckets[t.In(now.Location()).Format("2006-01-02")]++
	}
	s.Trend = make([]UserTrendPoint, 0, trendDays)
	for i := 0; i < trendDays; i++ {
		d := since.AddDate(0, 0, i).Format("2006-01-02")
		s.Trend = append(s.Trend, UserTrendPoint{Date: d, Count: buckets[d]})
	}
	return s, nil
}

// BulkUpdate applies a column patch (e.g. disabled / status) to many users at
// once and returns the number of rows affected. Department/role membership
// changes go through their own repos (join tables), not here.
func (r *UserRepo) BulkUpdate(ctx context.Context, ids []uint64, patch map[string]any) (int64, error) {
	if len(ids) == 0 || len(patch) == 0 {
		return 0, nil
	}
	res := r.db.WithContext(ctx).Model(&model.User{}).Where("id IN ?", ids).Updates(patch)
	return res.RowsAffected, res.Error
}

// BulkDelete removes users one-by-one so each goes through Delete's join-table
// cascade rather than orphaning role / department / MFA rows.
func (r *UserRepo) BulkDelete(ctx context.Context, ids []uint64) error {
	for _, id := range ids {
		if err := r.Delete(ctx, id); err != nil {
			return err
		}
	}
	return nil
}

// TagsForUsers returns the managed-tag ID set for each given user in one query.
func (r *UserRepo) TagsForUsers(ctx context.Context, ids []uint64) (map[uint64][]uint64, error) {
	out := make(map[uint64][]uint64, len(ids))
	if len(ids) == 0 {
		return out, nil
	}
	var rows []model.UserTag
	if err := r.db.WithContext(ctx).Where("user_id IN ?", ids).Find(&rows).Error; err != nil {
		return nil, err
	}
	for _, t := range rows {
		out[t.UserID] = append(out[t.UserID], t.TagID)
	}
	return out, nil
}

// SetUserTags replaces a user's managed-tag set in one transaction.
func (r *UserRepo) SetUserTags(ctx context.Context, userID uint64, tagIDs []uint64) error {
	return r.db.WithContext(ctx).Transaction(func(tx *gorm.DB) error {
		if err := tx.Where("user_id = ?", userID).Delete(&model.UserTag{}).Error; err != nil {
			return err
		}
		if len(tagIDs) == 0 {
			return nil
		}
		rows := make([]model.UserTag, len(tagIDs))
		for i, t := range tagIDs {
			rows[i] = model.UserTag{UserID: userID, TagID: t}
		}
		return tx.Create(&rows).Error
	})
}
