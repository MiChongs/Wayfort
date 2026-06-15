package repo

import (
	"context"
	"errors"
	"time"

	"github.com/michongs/jumpserver-anonymous/internal/model"
	"gorm.io/gorm"
)

// GatewayAgentRepo backs CRUD + lifecycle transitions for reverse-connect
// Gateway Agents (security-architecture.md §4 / §12).
type GatewayAgentRepo struct{ db *gorm.DB }

func NewGatewayAgentRepo(db *gorm.DB) *GatewayAgentRepo { return &GatewayAgentRepo{db: db} }

func (r *GatewayAgentRepo) Create(ctx context.Context, a *model.GatewayAgent) error {
	return r.db.WithContext(ctx).Create(a).Error
}

func (r *GatewayAgentRepo) Update(ctx context.Context, a *model.GatewayAgent) error {
	return r.db.WithContext(ctx).Save(a).Error
}

func (r *GatewayAgentRepo) Delete(ctx context.Context, id uint64) error {
	return r.db.WithContext(ctx).Delete(&model.GatewayAgent{}, id).Error
}

func (r *GatewayAgentRepo) FindByID(ctx context.Context, id uint64) (*model.GatewayAgent, error) {
	var a model.GatewayAgent
	err := r.db.WithContext(ctx).First(&a, id).Error
	if errors.Is(err, gorm.ErrRecordNotFound) {
		return nil, nil
	}
	return &a, err
}

// FindByFingerprint resolves an agent by its current certificate fingerprint —
// the identity the tunnel/renew paths verify against the registry.
func (r *GatewayAgentRepo) FindByFingerprint(ctx context.Context, fp string) (*model.GatewayAgent, error) {
	if fp == "" {
		return nil, nil
	}
	var a model.GatewayAgent
	err := r.db.WithContext(ctx).Where("fingerprint = ?", fp).First(&a).Error
	if errors.Is(err, gorm.ErrRecordNotFound) {
		return nil, nil
	}
	return &a, err
}

func (r *GatewayAgentRepo) ListByDomain(ctx context.Context, domainID uint64) ([]model.GatewayAgent, error) {
	var out []model.GatewayAgent
	err := r.db.WithContext(ctx).Where("domain_id = ?", domainID).Order("name").Find(&out).Error
	return out, err
}

func (r *GatewayAgentRepo) List(ctx context.Context) ([]model.GatewayAgent, error) {
	var out []model.GatewayAgent
	err := r.db.WithContext(ctx).Order("domain_id, name").Find(&out).Error
	return out, err
}

// UpdateStatus transitions an agent's status (e.g. activate pending→offline,
// or revoke). A targeted update so it never races a full-row Save.
func (r *GatewayAgentRepo) UpdateStatus(ctx context.Context, id uint64, status model.AgentStatus) error {
	return r.db.WithContext(ctx).Model(&model.GatewayAgent{}).
		Where("id = ?", id).Update("status", status).Error
}

// Touch records a heartbeat: bumps last_seen_at + owning gateway + stats and
// marks the agent online in one targeted write.
func (r *GatewayAgentRepo) Touch(ctx context.Context, id uint64, gateway, stats string, at time.Time) error {
	return r.db.WithContext(ctx).Model(&model.GatewayAgent{}).
		Where("id = ?", id).
		Updates(map[string]any{
			"last_seen_at": at,
			"last_gateway": gateway,
			"stats":        stats,
			"status":       model.AgentOnline,
		}).Error
}

// MarkOfflineStale flips agents whose last heartbeat is older than `before` to
// offline (without touching pending/revoked). Run by a background reaper.
func (r *GatewayAgentRepo) MarkOfflineStale(ctx context.Context, before time.Time) (int64, error) {
	res := r.db.WithContext(ctx).Model(&model.GatewayAgent{}).
		Where("status = ? AND (last_seen_at IS NULL OR last_seen_at < ?)", model.AgentOnline, before).
		Update("status", model.AgentOffline)
	return res.RowsAffected, res.Error
}

// CountByDomain reports how many agents reference a domain — used to block
// deletion of an agent domain that still has agents.
func (r *GatewayAgentRepo) CountByDomain(ctx context.Context, domainID uint64) (int64, error) {
	var n int64
	err := r.db.WithContext(ctx).Model(&model.GatewayAgent{}).
		Where("domain_id = ?", domainID).Count(&n).Error
	return n, err
}

// AgentEnrollTokenRepo backs one-time enrollment tokens. Only hashes are stored.
type AgentEnrollTokenRepo struct{ db *gorm.DB }

func NewAgentEnrollTokenRepo(db *gorm.DB) *AgentEnrollTokenRepo {
	return &AgentEnrollTokenRepo{db: db}
}

func (r *AgentEnrollTokenRepo) Create(ctx context.Context, t *model.AgentEnrollToken) error {
	return r.db.WithContext(ctx).Create(t).Error
}

// Consume atomically validates and burns a token by its hash: it must exist, be
// unused, and unexpired. Returns the row (for the domain id + CIDR check) on
// success, or nil if no live token matched. The UPDATE...WHERE used_at IS NULL
// guard makes the burn race-safe against two agents presenting the same token.
func (r *AgentEnrollTokenRepo) Consume(ctx context.Context, tokenHash string, now time.Time) (*model.AgentEnrollToken, error) {
	if tokenHash == "" {
		return nil, nil
	}
	var tok model.AgentEnrollToken
	err := r.db.WithContext(ctx).
		Where("token_hash = ? AND used_at IS NULL AND expires_at > ?", tokenHash, now).
		First(&tok).Error
	if errors.Is(err, gorm.ErrRecordNotFound) {
		return nil, nil
	}
	if err != nil {
		return nil, err
	}
	res := r.db.WithContext(ctx).Model(&model.AgentEnrollToken{}).
		Where("id = ? AND used_at IS NULL", tok.ID).
		Update("used_at", now)
	if res.Error != nil {
		return nil, res.Error
	}
	if res.RowsAffected == 0 {
		// Lost the race — another caller consumed it first.
		return nil, nil
	}
	tok.UsedAt = &now
	return &tok, nil
}

// DeleteExpired purges spent or expired tokens; run by a background reaper.
func (r *AgentEnrollTokenRepo) DeleteExpired(ctx context.Context, before time.Time) (int64, error) {
	res := r.db.WithContext(ctx).
		Where("expires_at < ? OR used_at IS NOT NULL", before).
		Delete(&model.AgentEnrollToken{})
	return res.RowsAffected, res.Error
}
