package repo

import (
	"context"

	"github.com/michongs/jumpserver-anonymous/internal/dialer"
	"github.com/michongs/jumpserver-anonymous/internal/model"
	"gorm.io/gorm"
)

// ProxyGroupRepo backs failover-group membership (proxy_group_members) and
// implements dialer.GroupReader so the chain builder can fan a group hop out to
// its member proxies.
type ProxyGroupRepo struct{ db *gorm.DB }

func NewProxyGroupRepo(db *gorm.DB) *ProxyGroupRepo { return &ProxyGroupRepo{db: db} }

// MembersOf implements dialer.GroupReader: member proxy rows joined with their
// ordering knobs, ordered by priority. Members whose proxy row is missing are
// skipped.
func (r *ProxyGroupRepo) MembersOf(ctx context.Context, groupID uint64) ([]dialer.GroupMemberSpec, error) {
	links, err := r.MembersForGroup(ctx, groupID)
	if err != nil {
		return nil, err
	}
	if len(links) == 0 {
		return nil, nil
	}
	ids := make([]uint64, 0, len(links))
	for _, l := range links {
		ids = append(ids, l.MemberID)
	}
	var proxies []model.Proxy
	if err := r.db.WithContext(ctx).Where("id IN ?", ids).Find(&proxies).Error; err != nil {
		return nil, err
	}
	byID := make(map[uint64]*model.Proxy, len(proxies))
	for i := range proxies {
		byID[proxies[i].ID] = &proxies[i]
	}
	out := make([]dialer.GroupMemberSpec, 0, len(links))
	for _, l := range links {
		p := byID[l.MemberID]
		if p == nil {
			continue
		}
		out = append(out, dialer.GroupMemberSpec{Proxy: p, Priority: l.Priority, Weight: l.Weight})
	}
	return out, nil
}

// MembersForGroup returns the raw membership links for a group, ordered.
func (r *ProxyGroupRepo) MembersForGroup(ctx context.Context, groupID uint64) ([]model.ProxyGroupMember, error) {
	var out []model.ProxyGroupMember
	err := r.db.WithContext(ctx).
		Where("group_id = ?", groupID).
		Order("priority asc, id asc").
		Find(&out).Error
	return out, err
}

// AllMembers returns every membership link grouped by group id — used to enrich
// the proxy list without an N+1 query.
func (r *ProxyGroupRepo) AllMembers(ctx context.Context) (map[uint64][]model.ProxyGroupMember, error) {
	var all []model.ProxyGroupMember
	if err := r.db.WithContext(ctx).Order("group_id asc, priority asc, id asc").Find(&all).Error; err != nil {
		return nil, err
	}
	out := make(map[uint64][]model.ProxyGroupMember, len(all))
	for _, m := range all {
		out[m.GroupID] = append(out[m.GroupID], m)
	}
	return out, nil
}

// SetMembers replaces a group's membership atomically.
func (r *ProxyGroupRepo) SetMembers(ctx context.Context, groupID uint64, members []model.ProxyGroupMember) error {
	return r.db.WithContext(ctx).Transaction(func(tx *gorm.DB) error {
		if err := tx.Where("group_id = ?", groupID).Delete(&model.ProxyGroupMember{}).Error; err != nil {
			return err
		}
		if len(members) == 0 {
			return nil
		}
		for i := range members {
			members[i].ID = 0
			members[i].GroupID = groupID
			if members[i].Weight <= 0 {
				members[i].Weight = 1
			}
		}
		return tx.Create(&members).Error
	})
}

// DeleteByGroup removes all of a group's membership links (called when the group
// proxy itself is deleted).
func (r *ProxyGroupRepo) DeleteByGroup(ctx context.Context, groupID uint64) error {
	return r.db.WithContext(ctx).Where("group_id = ?", groupID).Delete(&model.ProxyGroupMember{}).Error
}

// RemoveMember drops a single membership link by its row id.
func (r *ProxyGroupRepo) RemoveMember(ctx context.Context, groupID, memberRowID uint64) error {
	return r.db.WithContext(ctx).
		Where("group_id = ? AND id = ?", groupID, memberRowID).
		Delete(&model.ProxyGroupMember{}).Error
}
