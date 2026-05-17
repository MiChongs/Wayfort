// Package asset turns AssetGrant rows into "which node IDs can this user do
// <action> on?" answers. Results are cached in Redis for 60s; mutating handlers
// must invalidate on write.
package asset

import (
	"context"
	"encoding/json"
	"fmt"
	"strings"
	"time"

	"github.com/michongs/jumpserver-anonymous/internal/model"
	"github.com/michongs/jumpserver-anonymous/internal/repo"
	"github.com/redis/go-redis/v9"
)

// Action codes used in AssetGrant.Actions.
const (
	ActionConnect      = "connect"
	ActionSFTPRead     = "sftp_read"
	ActionSFTPWrite    = "sftp_write"
	ActionPortForward  = "port_forward"
	ActionFileUpload   = "upload"
	ActionFileDownload = "download"
	ActionAll          = "*"
)

type Resolver struct {
	grants *repo.GrantRepo
	groups *repo.UserGroupRepo
	roles  *repo.RoleRepo
	users  *repo.UserRepo
	ag     *repo.AssetGroupRepo
	tags   *repo.TagRepo
	nodes  *repo.NodeRepo
	cache  *redis.Client
	ttl    time.Duration
}

func NewResolver(
	grants *repo.GrantRepo,
	groups *repo.UserGroupRepo,
	roles *repo.RoleRepo,
	users *repo.UserRepo,
	ag *repo.AssetGroupRepo,
	tags *repo.TagRepo,
	nodes *repo.NodeRepo,
	cache *redis.Client,
) *Resolver {
	return &Resolver{grants: grants, groups: groups, roles: roles, users: users, ag: ag, tags: tags, nodes: nodes, cache: cache, ttl: 60 * time.Second}
}

type accessSet struct {
	All     map[string]bool      `json:"all"`
	Nodes   map[uint64][]string  `json:"nodes"`
}

func newAccessSet() *accessSet {
	return &accessSet{All: map[string]bool{}, Nodes: map[uint64][]string{}}
}

// VisibleNodeIDs returns the node IDs the user may perform `action` on, plus
// a boolean indicating "all nodes" (for which we don't enumerate).
func (r *Resolver) VisibleNodeIDs(ctx context.Context, userID uint64, action string) (nodes []uint64, all bool, err error) {
	set, err := r.compute(ctx, userID)
	if err != nil {
		return nil, false, err
	}
	if set.All[action] || set.All[ActionAll] {
		return nil, true, nil
	}
	out := make([]uint64, 0, len(set.Nodes))
	for nid, actions := range set.Nodes {
		if containsAction(actions, action) {
			out = append(out, nid)
		}
	}
	return out, false, nil
}

// Check returns true iff the user may perform action on the specific node.
func (r *Resolver) Check(ctx context.Context, userID, nodeID uint64, action string) (bool, error) {
	set, err := r.compute(ctx, userID)
	if err != nil {
		return false, err
	}
	if set.All[action] || set.All[ActionAll] {
		return true, nil
	}
	return containsAction(set.Nodes[nodeID], action), nil
}

// Invalidate drops the cache for one user; call after a grant changes.
func (r *Resolver) Invalidate(ctx context.Context, userID uint64) {
	if r.cache != nil {
		_ = r.cache.Del(ctx, cacheKey(userID)).Err()
	}
}

// InvalidateAll drops the cache for everyone; call after global grant changes.
func (r *Resolver) InvalidateAll(ctx context.Context) {
	if r.cache == nil {
		return
	}
	iter := r.cache.Scan(ctx, 0, "acl:user:*", 200).Iterator()
	for iter.Next(ctx) {
		_ = r.cache.Del(ctx, iter.Val()).Err()
	}
}

func cacheKey(userID uint64) string { return fmt.Sprintf("acl:user:%d", userID) }

func (r *Resolver) compute(ctx context.Context, userID uint64) (*accessSet, error) {
	// Cache hit?
	if r.cache != nil {
		if raw, err := r.cache.Get(ctx, cacheKey(userID)).Result(); err == nil && raw != "" {
			var s accessSet
			if json.Unmarshal([]byte(raw), &s) == nil {
				return &s, nil
			}
		}
	}
	set := newAccessSet()

	// Identify the user (admin → all everything).
	user, err := r.users.FindByID(ctx, userID)
	if err != nil {
		return nil, err
	}
	if user == nil {
		return set, nil
	}
	if user.IsAdmin {
		set.All[ActionAll] = true
		r.persist(ctx, userID, set)
		return set, nil
	}

	// Gather grantees: the user, their groups, their roles, their department.
	granteeIDs := map[model.GranteeType][]uint64{
		model.GranteeUser: {user.ID},
	}
	if user.DepartmentID != nil {
		granteeIDs[model.GranteeDepartment] = []uint64{*user.DepartmentID}
	}
	groupIDs, err := r.groups.GroupsForUser(ctx, userID)
	if err == nil && len(groupIDs) > 0 {
		granteeIDs[model.GranteeGroup] = groupIDs
	}
	roles, err := r.roles.RolesForUser(ctx, userID)
	if err == nil && len(roles) > 0 {
		ids := make([]uint64, 0, len(roles))
		for _, role := range roles {
			ids = append(ids, role.ID)
		}
		granteeIDs[model.GranteeRole] = ids
	}

	// Fetch every grant that targets one of these grantees.
	grants := make([]model.AssetGrant, 0)
	for gt, ids := range granteeIDs {
		rows, err := r.grants.ListForGrantees(ctx, []model.GranteeType{gt}, ids)
		if err != nil {
			return nil, err
		}
		grants = append(grants, rows...)
	}

	// Resolve subjects to node-id sets.
	for _, g := range grants {
		actions := splitActions(g.Actions)
		switch g.SubjectType {
		case model.SubjectAll:
			for _, a := range actions {
				set.All[a] = true
			}
		case model.SubjectNode:
			merge(set.Nodes, g.SubjectID, actions)
		case model.SubjectAssetGroup:
			nodes, err := r.expandGroup(ctx, g.SubjectID)
			if err != nil {
				return nil, err
			}
			for _, nid := range nodes {
				merge(set.Nodes, nid, actions)
			}
		case model.SubjectTag:
			nodes, err := r.tags.NodesWithTag(ctx, []uint64{g.SubjectID})
			if err != nil {
				return nil, err
			}
			for _, nid := range nodes {
				merge(set.Nodes, nid, actions)
			}
		}
	}

	r.persist(ctx, userID, set)
	return set, nil
}

func (r *Resolver) expandGroup(ctx context.Context, groupID uint64) ([]uint64, error) {
	row, err := r.ag.FindByID(ctx, groupID)
	if err != nil || row == nil {
		return nil, err
	}
	subtree, err := r.ag.Subtree(ctx, row.Path)
	if err != nil {
		return nil, err
	}
	ids := make([]uint64, 0, len(subtree))
	for _, g := range subtree {
		ids = append(ids, g.ID)
	}
	return r.ag.NodesIn(ctx, ids)
}

func (r *Resolver) persist(ctx context.Context, userID uint64, set *accessSet) {
	if r.cache == nil {
		return
	}
	b, err := json.Marshal(set)
	if err == nil {
		_ = r.cache.Set(ctx, cacheKey(userID), b, r.ttl).Err()
	}
}

func splitActions(s string) []string {
	if s == "" {
		return nil
	}
	parts := strings.Split(s, ",")
	out := make([]string, 0, len(parts))
	for _, p := range parts {
		p = strings.TrimSpace(p)
		if p != "" {
			out = append(out, p)
		}
	}
	return out
}

func merge(m map[uint64][]string, nid uint64, actions []string) {
	existing := m[nid]
	for _, a := range actions {
		if !containsAction(existing, a) {
			existing = append(existing, a)
		}
	}
	m[nid] = existing
}

func containsAction(actions []string, want string) bool {
	for _, a := range actions {
		if a == want || a == ActionAll {
			return true
		}
	}
	return false
}
