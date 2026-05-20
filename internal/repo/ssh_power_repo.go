package repo

import (
	"context"
	"errors"
	"time"

	"github.com/michongs/jumpserver-anonymous/internal/model"
	"gorm.io/gorm"
)

// SSHKeyRepo — Phase 12 user-owned keypair store.
type SSHKeyRepo struct{ db *gorm.DB }

func NewSSHKeyRepo(db *gorm.DB) *SSHKeyRepo { return &SSHKeyRepo{db: db} }

func (r *SSHKeyRepo) Create(ctx context.Context, k *model.SSHKey) error {
	return r.db.WithContext(ctx).Create(k).Error
}

func (r *SSHKeyRepo) Update(ctx context.Context, k *model.SSHKey) error {
	return r.db.WithContext(ctx).Save(k).Error
}

func (r *SSHKeyRepo) Delete(ctx context.Context, userID, id uint64) error {
	return r.db.WithContext(ctx).Where("user_id = ?", userID).Delete(&model.SSHKey{}, id).Error
}

func (r *SSHKeyRepo) FindByID(ctx context.Context, userID, id uint64) (*model.SSHKey, error) {
	var k model.SSHKey
	err := r.db.WithContext(ctx).Where("user_id = ?", userID).First(&k, id).Error
	if errors.Is(err, gorm.ErrRecordNotFound) {
		return nil, nil
	}
	return &k, err
}

func (r *SSHKeyRepo) List(ctx context.Context, userID uint64) ([]model.SSHKey, error) {
	var out []model.SSHKey
	err := r.db.WithContext(ctx).Where("user_id = ?", userID).Order("created_at DESC").Find(&out).Error
	return out, err
}

func (r *SSHKeyRepo) BumpUsage(ctx context.Context, id uint64) error {
	now := time.Now()
	return r.db.WithContext(ctx).Model(&model.SSHKey{}).Where("id = ?", id).Update("last_used_at", &now).Error
}

// KnownHostRepo — accepted host fingerprints.
type KnownHostRepo struct{ db *gorm.DB }

func NewKnownHostRepo(db *gorm.DB) *KnownHostRepo { return &KnownHostRepo{db: db} }

func (r *KnownHostRepo) Create(ctx context.Context, h *model.KnownHost) error {
	return r.db.WithContext(ctx).Create(h).Error
}

func (r *KnownHostRepo) Update(ctx context.Context, h *model.KnownHost) error {
	return r.db.WithContext(ctx).Save(h).Error
}

func (r *KnownHostRepo) Delete(ctx context.Context, userID, id uint64) error {
	return r.db.WithContext(ctx).Where("user_id = ?", userID).Delete(&model.KnownHost{}, id).Error
}

func (r *KnownHostRepo) List(ctx context.Context, userID uint64) ([]model.KnownHost, error) {
	var out []model.KnownHost
	err := r.db.WithContext(ctx).Where("user_id = ?", userID).Order("accepted_at DESC").Find(&out).Error
	return out, err
}

func (r *KnownHostRepo) FindByID(ctx context.Context, userID, id uint64) (*model.KnownHost, error) {
	var h model.KnownHost
	err := r.db.WithContext(ctx).Where("user_id = ?", userID).First(&h, id).Error
	if errors.Is(err, gorm.ErrRecordNotFound) {
		return nil, nil
	}
	return &h, err
}

// BulkRunRepo — historical batched command execution.
type BulkRunRepo struct{ db *gorm.DB }

func NewBulkRunRepo(db *gorm.DB) *BulkRunRepo { return &BulkRunRepo{db: db} }

func (r *BulkRunRepo) Create(ctx context.Context, run *model.BulkRun) error {
	return r.db.WithContext(ctx).Create(run).Error
}

func (r *BulkRunRepo) Update(ctx context.Context, run *model.BulkRun) error {
	return r.db.WithContext(ctx).Save(run).Error
}

func (r *BulkRunRepo) List(ctx context.Context, userID uint64, limit int) ([]model.BulkRun, error) {
	if limit <= 0 || limit > 200 {
		limit = 50
	}
	var out []model.BulkRun
	err := r.db.WithContext(ctx).
		Where("user_id = ?", userID).
		Order("created_at DESC").
		Limit(limit).
		Find(&out).Error
	return out, err
}

func (r *BulkRunRepo) FindByID(ctx context.Context, userID, id uint64) (*model.BulkRun, error) {
	var run model.BulkRun
	err := r.db.WithContext(ctx).Where("user_id = ?", userID).First(&run, id).Error
	if errors.Is(err, gorm.ErrRecordNotFound) {
		return nil, nil
	}
	return &run, err
}

func (r *BulkRunRepo) Delete(ctx context.Context, userID, id uint64) error {
	return r.db.WithContext(ctx).Transaction(func(tx *gorm.DB) error {
		if err := tx.Where("user_id = ?", userID).Delete(&model.BulkRun{}, id).Error; err != nil {
			return err
		}
		return tx.Where("run_id = ?", id).Delete(&model.BulkRunResult{}).Error
	})
}

// AppendResult records one per-node row to an existing BulkRun.
func (r *BulkRunRepo) AppendResult(ctx context.Context, res *model.BulkRunResult) error {
	return r.db.WithContext(ctx).Create(res).Error
}

// ResultsFor returns all per-node results for a run.
func (r *BulkRunRepo) ResultsFor(ctx context.Context, runID uint64) ([]model.BulkRunResult, error) {
	var out []model.BulkRunResult
	err := r.db.WithContext(ctx).Where("run_id = ?", runID).Order("node_id").Find(&out).Error
	return out, err
}
