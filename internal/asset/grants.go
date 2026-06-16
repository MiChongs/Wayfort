// Package asset turns AssetGrant rows into "which node IDs can this user do
// <action> on?" answers. Results are cached in Redis for 60s; mutating handlers
// must invalidate on write.
package asset

import (
	"context"
	"encoding/json"
	"fmt"
	"sort"
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
	grants        *repo.GrantRepo
	groups        *repo.UserGroupRepo
	depts         *repo.DepartmentRepo
	roles         *repo.RoleRepo
	users         *repo.UserRepo
	ag            *repo.AssetGroupRepo
	tags          *repo.TagRepo
	nodes         *repo.NodeRepo
	accessFolders *repo.AccessFolderRepo
	accessItems   *repo.AccessItemRepo
	cache         *redis.Client
	ttl           time.Duration
}

func NewResolver(
	grants *repo.GrantRepo,
	groups *repo.UserGroupRepo,
	depts *repo.DepartmentRepo,
	roles *repo.RoleRepo,
	users *repo.UserRepo,
	ag *repo.AssetGroupRepo,
	tags *repo.TagRepo,
	nodes *repo.NodeRepo,
	accessFolders *repo.AccessFolderRepo,
	accessItems *repo.AccessItemRepo,
	cache *redis.Client,
) *Resolver {
	return &Resolver{grants: grants, groups: groups, depts: depts, roles: roles, users: users, ag: ag, tags: tags, nodes: nodes, accessFolders: accessFolders, accessItems: accessItems, cache: cache, ttl: 60 * time.Second}
}

// treeNodeGrant is one node an owner's authorisation tree grants, with the
// effective action set and expiry after folder inheritance is applied.
type treeNodeGrant struct {
	OwnerType model.GranteeType
	OwnerID   uint64
	NodeID    uint64
	Actions   []string
	ValidTo   *time.Time
}

// effFolder walks a folder's ancestor chain and returns the first non-empty
// Actions and first non-nil ValidFrom/ValidTo it finds (the inherited defaults).
func effFolder(folders map[uint64]model.AccessFolder, folderID uint64) (actions string, validFrom, validTo *time.Time) {
	visited := map[uint64]bool{}
	cur, ok := folders[folderID]
	for ok && !visited[cur.ID] {
		visited[cur.ID] = true
		if actions == "" && cur.Actions != "" {
			actions = cur.Actions
		}
		if validFrom == nil && cur.ValidFrom != nil {
			validFrom = cur.ValidFrom
		}
		if validTo == nil && cur.ValidTo != nil {
			validTo = cur.ValidTo
		}
		if cur.ParentID == nil {
			break
		}
		cur, ok = folders[*cur.ParentID]
	}
	return actions, validFrom, validTo
}

// resolveTrees flattens access folders + items (possibly spanning many owners of
// one type) into per-node effective grants, honouring folder inheritance. When
// onlyValid is true, grants outside their effective validity window are dropped.
func resolveTrees(folders []model.AccessFolder, items []model.AccessItem, now time.Time, onlyValid bool) []treeNodeGrant {
	byOwner := map[uint64]map[uint64]model.AccessFolder{}
	for _, f := range folders {
		m := byOwner[f.OwnerID]
		if m == nil {
			m = map[uint64]model.AccessFolder{}
			byOwner[f.OwnerID] = m
		}
		m[f.ID] = f
	}
	out := make([]treeNodeGrant, 0, len(items))
	for _, it := range items {
		fActions, fFrom, fTo := "", (*time.Time)(nil), (*time.Time)(nil)
		if m := byOwner[it.OwnerID]; m != nil {
			fActions, fFrom, fTo = effFolder(m, it.FolderID)
		}
		actions := it.Actions
		if actions == "" {
			actions = fActions
		}
		if actions == "" {
			actions = ActionConnect
		}
		vf := it.ValidFrom
		if vf == nil {
			vf = fFrom
		}
		vt := it.ValidTo
		if vt == nil {
			vt = fTo
		}
		if onlyValid {
			if vf != nil && vf.After(now) {
				continue
			}
			if vt != nil && vt.Before(now) {
				continue
			}
		}
		out = append(out, treeNodeGrant{OwnerType: it.OwnerType, OwnerID: it.OwnerID, NodeID: it.NodeID, Actions: splitActions(actions), ValidTo: vt})
	}
	return out
}

// treeGrantsForGrantees resolves the authorisation trees owned by the supplied
// grantees (roles excluded — they don't own trees). onlyValid drops expired.
func (r *Resolver) treeGrantsForGrantees(ctx context.Context, granteeIDs map[model.GranteeType][]uint64, onlyValid bool) ([]treeNodeGrant, error) {
	if r.accessItems == nil || r.accessFolders == nil {
		return nil, nil
	}
	now := time.Now()
	var out []treeNodeGrant
	for gt, ids := range granteeIDs {
		if gt == model.GranteeRole {
			continue
		}
		folders, err := r.accessFolders.ListByOwnerSet(ctx, gt, ids)
		if err != nil {
			return nil, err
		}
		items, err := r.accessItems.ListByOwnerSet(ctx, gt, ids)
		if err != nil {
			return nil, err
		}
		out = append(out, resolveTrees(folders, items, now, onlyValid)...)
	}
	return out, nil
}

// DirectoryForUser returns the raw access folders + items reaching a user
// (their own tree plus the trees of their groups / departments). Backs
// GET /me/directory; the handler filters by connectability and prunes.
func (r *Resolver) DirectoryForUser(ctx context.Context, userID uint64) ([]model.AccessFolder, []model.AccessItem, error) {
	if r.accessItems == nil {
		return nil, nil, nil
	}
	user, err := r.users.FindByID(ctx, userID)
	if err != nil || user == nil {
		return nil, nil, err
	}
	granteeIDs := r.granteesForUser(ctx, user)
	var folders []model.AccessFolder
	var items []model.AccessItem
	for gt, ids := range granteeIDs {
		if gt == model.GranteeRole {
			continue
		}
		fs, err := r.accessFolders.ListByOwnerSet(ctx, gt, ids)
		if err != nil {
			return nil, nil, err
		}
		is, err := r.accessItems.ListByOwnerSet(ctx, gt, ids)
		if err != nil {
			return nil, nil, err
		}
		folders = append(folders, fs...)
		items = append(items, is...)
	}
	return folders, items, nil
}

// granteesForUser gathers the (granteeType → ids) map for a user, expanding
// department / user-group ancestors (a child inherits its ancestors' grants)
// and the user's roles. Shared by compute() and the directory lookups.
func (r *Resolver) granteesForUser(ctx context.Context, user *model.User) map[model.GranteeType][]uint64 {
	granteeIDs := map[model.GranteeType][]uint64{
		model.GranteeUser: {user.ID},
	}
	if deptIDs, err := r.depts.DepartmentsForUser(ctx, user.ID); err == nil && len(deptIDs) > 0 {
		if expanded, err := r.depts.ExpandWithAncestors(ctx, deptIDs); err == nil && len(expanded) > 0 {
			granteeIDs[model.GranteeDepartment] = expanded
		}
	}
	if groupIDs, err := r.groups.GroupsForUser(ctx, user.ID); err == nil && len(groupIDs) > 0 {
		if expanded, err := r.groups.ExpandWithAncestors(ctx, groupIDs); err == nil && len(expanded) > 0 {
			granteeIDs[model.GranteeGroup] = expanded
		} else {
			granteeIDs[model.GranteeGroup] = groupIDs
		}
	}
	if roles, err := r.roles.RolesForUser(ctx, user.ID); err == nil && len(roles) > 0 {
		ids := make([]uint64, 0, len(roles))
		for _, role := range roles {
			ids = append(ids, role.ID)
		}
		granteeIDs[model.GranteeRole] = ids
	}
	return granteeIDs
}

// GranteesForUser is the exported form of granteesForUser: it loads the user and
// returns the (granteeType → ids) map with department / group ancestors and
// roles expanded. Used by the access-control rule engine to match a rule's USER
// dimension (user / group / department / role selectors) without re-implementing
// the ancestor-expansion logic.
func (r *Resolver) GranteesForUser(ctx context.Context, userID uint64) (map[model.GranteeType][]uint64, error) {
	user, err := r.users.FindByID(ctx, userID)
	if err != nil {
		return nil, err
	}
	if user == nil {
		return map[model.GranteeType][]uint64{}, nil
	}
	return r.granteesForUser(ctx, user), nil
}

type accessSet struct {
	All   map[string]bool     `json:"all"`
	Nodes map[uint64][]string `json:"nodes"`
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

	// Gather grantees: the user, their groups, their roles, their departments.
	// Departments and groups are trees — a child inherits its ancestors' grants,
	// so we expand both to include every ancestor before matching grants.
	granteeIDs := r.granteesForUser(ctx, user)

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

	// Per-object authorisation trees (授权目录): the user inherits the trees
	// owned by themselves and by each group / department they belong to. Folder
	// inheritance is applied and expired grants dropped; a node reachable via
	// both a tree and an AssetGrant ends up with the union of actions.
	treeGrants, err := r.treeGrantsForGrantees(ctx, granteeIDs, true)
	if err != nil {
		return nil, err
	}
	for _, g := range treeGrants {
		merge(set.Nodes, g.NodeID, g.Actions)
	}

	r.persist(ctx, userID, set)
	return set, nil
}

// GranteeRef identifies who an access came from (so the UI can show
// "来自：运维组 / 角色 DBA"). Names are resolved on the frontend, which already
// holds the user/role/group/department lists.
type GranteeRef struct {
	Type model.GranteeType `json:"type"`
	ID   uint64            `json:"id"`
}

// NodeAccess is one node a grantee can reach, with the merged action set and
// every grant source that contributed it. ValidTo summarises when access ends
// (the latest expiry across contributing grants; nil = permanent, i.e. at least
// one contributing grant has no end). GroupIDs lists the asset groups this node
// belongs to so the frontend can hang it on the group hierarchy (授权树).
type NodeAccess struct {
	NodeID   uint64       `json:"node_id"`
	Actions  []string     `json:"actions"`
	Sources  []GranteeRef `json:"sources"`
	ValidTo  *time.Time   `json:"valid_to,omitempty"`
	GroupIDs []uint64     `json:"group_ids,omitempty"`
}

// Explanation answers "what can this grantee actually reach?". For a user it is
// resolved through their groups / roles / department; for a role/group/dept it
// reflects what that grantee itself grants.
type Explanation struct {
	AllActions []string     `json:"all_actions"` // from "全部资产" grants
	AllSources []GranteeRef `json:"all_sources"`
	AllValidTo *time.Time   `json:"all_valid_to,omitempty"` // expiry of the "全部资产" grants; nil = permanent
	Nodes      []NodeAccess `json:"nodes"`
}

// Explain resolves the effective node access for a grantee, tracking sources.
func (r *Resolver) Explain(ctx context.Context, gt model.GranteeType, id uint64) (*Explanation, error) {
	granteeIDs := map[model.GranteeType][]uint64{}
	if gt == model.GranteeUser {
		granteeIDs[model.GranteeUser] = []uint64{id}
		if u, _ := r.users.FindByID(ctx, id); u != nil {
			if deptIDs, err := r.depts.DepartmentsForUser(ctx, id); err == nil && len(deptIDs) > 0 {
				if expanded, err := r.depts.ExpandWithAncestors(ctx, deptIDs); err == nil {
					granteeIDs[model.GranteeDepartment] = expanded
				}
			}
			if gids, err := r.groups.GroupsForUser(ctx, id); err == nil && len(gids) > 0 {
				if expanded, err := r.groups.ExpandWithAncestors(ctx, gids); err == nil {
					granteeIDs[model.GranteeGroup] = expanded
				} else {
					granteeIDs[model.GranteeGroup] = gids
				}
			}
			if roles, err := r.roles.RolesForUser(ctx, id); err == nil && len(roles) > 0 {
				ids := make([]uint64, 0, len(roles))
				for _, ro := range roles {
					ids = append(ids, ro.ID)
				}
				granteeIDs[model.GranteeRole] = ids
			}
		}
	} else if gt == model.GranteeDepartment {
		// A department's effective access includes grants on its ancestors.
		if expanded, err := r.depts.ExpandWithAncestors(ctx, []uint64{id}); err == nil && len(expanded) > 0 {
			granteeIDs[gt] = expanded
		} else {
			granteeIDs[gt] = []uint64{id}
		}
	} else if gt == model.GranteeGroup {
		if expanded, err := r.groups.ExpandWithAncestors(ctx, []uint64{id}); err == nil && len(expanded) > 0 {
			granteeIDs[gt] = expanded
		} else {
			granteeIDs[gt] = []uint64{id}
		}
	} else {
		granteeIDs[gt] = []uint64{id}
	}

	type acc struct {
		actions      map[string]bool
		sources      map[GranteeRef]bool
		hasPermanent bool       // a contributing grant has no end → access never expires
		latest       *time.Time // otherwise, the latest expiry among contributing grants
	}
	nodeAcc := map[uint64]*acc{}
	allActions := map[string]bool{}
	allSources := map[GranteeRef]bool{}
	allHasPermanent := false
	var allLatest *time.Time
	bumpValidity := func(hasPermanent *bool, latest **time.Time, validTo *time.Time) {
		if validTo == nil {
			*hasPermanent = true
			return
		}
		if *latest == nil || validTo.After(**latest) {
			v := *validTo
			*latest = &v
		}
	}
	add := func(nid uint64, actions []string, src GranteeRef, validTo *time.Time) {
		a := nodeAcc[nid]
		if a == nil {
			a = &acc{actions: map[string]bool{}, sources: map[GranteeRef]bool{}}
			nodeAcc[nid] = a
		}
		for _, x := range actions {
			a.actions[x] = true
		}
		a.sources[src] = true
		bumpValidity(&a.hasPermanent, &a.latest, validTo)
	}

	for gtype, ids := range granteeIDs {
		rows, err := r.grants.ListForGrantees(ctx, []model.GranteeType{gtype}, ids)
		if err != nil {
			return nil, err
		}
		for _, g := range rows {
			actions := splitActions(g.Actions)
			src := GranteeRef{Type: g.GranteeType, ID: g.GranteeID}
			switch g.SubjectType {
			case model.SubjectAll:
				for _, a := range actions {
					allActions[a] = true
				}
				allSources[src] = true
				bumpValidity(&allHasPermanent, &allLatest, g.ValidTo)
			case model.SubjectNode:
				add(g.SubjectID, actions, src, g.ValidTo)
			case model.SubjectAssetGroup:
				nodes, err := r.expandGroup(ctx, g.SubjectID)
				if err != nil {
					return nil, err
				}
				for _, nid := range nodes {
					add(nid, actions, src, g.ValidTo)
				}
			case model.SubjectTag:
				nodes, err := r.tags.NodesWithTag(ctx, []uint64{g.SubjectID})
				if err != nil {
					return nil, err
				}
				for _, nid := range nodes {
					add(nid, actions, src, g.ValidTo)
				}
			}
		}
	}

	// Per-object authorisation trees contribute node access for the same
	// grantees (tracked under the owning grantee as the source).
	treeGrants, err := r.treeGrantsForGrantees(ctx, granteeIDs, true)
	if err != nil {
		return nil, err
	}
	for _, g := range treeGrants {
		add(g.NodeID, g.Actions, GranteeRef{Type: g.OwnerType, ID: g.OwnerID}, g.ValidTo)
	}

	out := &Explanation{AllActions: sortedKeys(allActions), AllSources: refKeys(allSources), Nodes: make([]NodeAccess, 0, len(nodeAcc))}
	if !allHasPermanent {
		out.AllValidTo = allLatest
	}
	// One batch query to hang every reachable node on its asset groups.
	nodeIDs := make([]uint64, 0, len(nodeAcc))
	for nid := range nodeAcc {
		nodeIDs = append(nodeIDs, nid)
	}
	groupsByNode, err := r.ag.GroupsForNodes(ctx, nodeIDs)
	if err != nil {
		return nil, err
	}
	for nid, a := range nodeAcc {
		na := NodeAccess{NodeID: nid, Actions: sortedKeys(a.actions), Sources: refKeys(a.sources), GroupIDs: groupsByNode[nid]}
		if !a.hasPermanent {
			na.ValidTo = a.latest
		}
		out.Nodes = append(out.Nodes, na)
	}
	return out, nil
}

// SubjectAccess is one grantee that can reach a given node, with how (via a
// direct node grant, an asset group, a tag, or "全部资产") and when it expires.
type SubjectAccess struct {
	GranteeType model.GranteeType `json:"grantee_type"`
	GranteeID   uint64            `json:"grantee_id"`
	Actions     []string          `json:"actions"`
	Via         model.SubjectType `json:"via"`
	GrantID     uint64            `json:"grant_id"`
	ValidTo     *time.Time        `json:"valid_to,omitempty"`
}

// WhoCanAccessNode lists every grant that lets some grantee reach the node,
// expanding asset-group / tag / "全部资产" subjects. Memoizes group & tag
// expansions so the scan stays cheap at admin scale.
func (r *Resolver) WhoCanAccessNode(ctx context.Context, nodeID uint64) ([]SubjectAccess, error) {
	all, err := r.grants.List(ctx)
	if err != nil {
		return nil, err
	}
	groupHas := map[uint64]bool{}
	tagHas := map[uint64]bool{}
	groupChecked := map[uint64]bool{}
	tagChecked := map[uint64]bool{}
	out := make([]SubjectAccess, 0)
	for _, g := range all {
		include := false
		switch g.SubjectType {
		case model.SubjectAll:
			include = true
		case model.SubjectNode:
			include = g.SubjectID == nodeID
		case model.SubjectAssetGroup:
			if !groupChecked[g.SubjectID] {
				groupChecked[g.SubjectID] = true
				nodes, err := r.expandGroup(ctx, g.SubjectID)
				if err != nil {
					return nil, err
				}
				groupHas[g.SubjectID] = containsUint(nodes, nodeID)
			}
			include = groupHas[g.SubjectID]
		case model.SubjectTag:
			if !tagChecked[g.SubjectID] {
				tagChecked[g.SubjectID] = true
				nodes, err := r.tags.NodesWithTag(ctx, []uint64{g.SubjectID})
				if err != nil {
					return nil, err
				}
				tagHas[g.SubjectID] = containsUint(nodes, nodeID)
			}
			include = tagHas[g.SubjectID]
		}
		if !include {
			continue
		}
		out = append(out, SubjectAccess{
			GranteeType: g.GranteeType,
			GranteeID:   g.GranteeID,
			Actions:     splitActions(g.Actions),
			Via:         g.SubjectType,
			GrantID:     g.ID,
			ValidTo:     g.ValidTo,
		})
	}

	// Per-object authorisation trees that place this node. Resolve each owning
	// tree's effective permission for the node (folder inheritance applied).
	if r.accessItems != nil {
		items, err := r.accessItems.ListByNode(ctx, nodeID)
		if err != nil {
			return nil, err
		}
		foldersCache := map[string]map[uint64]model.AccessFolder{}
		for _, it := range items {
			key := string(it.OwnerType) + ":" + fmt.Sprint(it.OwnerID)
			fm := foldersCache[key]
			if fm == nil {
				fs, err := r.accessFolders.ListByOwner(ctx, it.OwnerType, it.OwnerID)
				if err != nil {
					return nil, err
				}
				fm = make(map[uint64]model.AccessFolder, len(fs))
				for _, f := range fs {
					fm[f.ID] = f
				}
				foldersCache[key] = fm
			}
			fActions, _, fTo := effFolder(fm, it.FolderID)
			actions := it.Actions
			if actions == "" {
				actions = fActions
			}
			if actions == "" {
				actions = ActionConnect
			}
			vt := it.ValidTo
			if vt == nil {
				vt = fTo
			}
			out = append(out, SubjectAccess{
				GranteeType: it.OwnerType,
				GranteeID:   it.OwnerID,
				Actions:     splitActions(actions),
				Via:         model.SubjectCatalog,
				GrantID:     it.ID,
				ValidTo:     vt,
			})
		}
	}
	return out, nil
}

func sortedKeys(m map[string]bool) []string {
	out := make([]string, 0, len(m))
	for k := range m {
		out = append(out, k)
	}
	sort.Strings(out)
	return out
}

func refKeys(m map[GranteeRef]bool) []GranteeRef {
	out := make([]GranteeRef, 0, len(m))
	for k := range m {
		out = append(out, k)
	}
	return out
}

func containsUint(s []uint64, want uint64) bool {
	for _, v := range s {
		if v == want {
			return true
		}
	}
	return false
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
