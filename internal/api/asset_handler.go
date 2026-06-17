package api

import (
	"fmt"
	"net/http"
	"strconv"
	"strings"
	"time"

	"github.com/gin-gonic/gin"
	"github.com/michongs/wayfort/internal/asset"
	"github.com/michongs/wayfort/internal/auth"
	"github.com/michongs/wayfort/internal/model"
	"github.com/michongs/wayfort/internal/repo"
)

// ----- Asset groups -----

type AssetGroupHandler struct {
	Repo     *repo.AssetGroupRepo
	Resolver *asset.Resolver
}

type assetGroupPayload struct {
	Name        string  `json:"name"`
	ParentID    *uint64 `json:"parent_id"`
	Description string  `json:"description"`
}

// assetGroupView wraps a model.AssetGroup with its current member node IDs.
// The frontend workspace tree uses node_ids to render "group → members"
// without a second round-trip.
type assetGroupView struct {
	model.AssetGroup
	NodeIDs []uint64 `json:"node_ids"`
}

func (h *AssetGroupHandler) List(c *gin.Context) {
	rows, err := h.Repo.List(c.Request.Context())
	if err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": err.Error()})
		return
	}
	out := make([]assetGroupView, 0, len(rows))
	if len(rows) > 0 {
		ids := make([]uint64, 0, len(rows))
		for _, g := range rows {
			ids = append(ids, g.ID)
		}
		// One query, group by group_id client-side.
		members, err := h.Repo.MembersByGroup(c.Request.Context(), ids)
		if err != nil {
			c.JSON(http.StatusInternalServerError, gin.H{"error": err.Error()})
			return
		}
		for _, g := range rows {
			out = append(out, assetGroupView{AssetGroup: g, NodeIDs: members[g.ID]})
		}
	}
	c.JSON(http.StatusOK, gin.H{"asset_groups": out})
}

func (h *AssetGroupHandler) Create(c *gin.Context) {
	var p assetGroupPayload
	if err := c.ShouldBindJSON(&p); err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"error": err.Error()})
		return
	}
	row := &model.AssetGroup{Name: p.Name, ParentID: p.ParentID, Description: p.Description}
	if err := h.Repo.Create(c.Request.Context(), row); err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": err.Error()})
		return
	}
	row.Path = fmt.Sprintf("%d", row.ID)
	if p.ParentID != nil {
		parent, _ := h.Repo.FindByID(c.Request.Context(), *p.ParentID)
		if parent != nil {
			row.Path = parent.Path + "/" + fmt.Sprintf("%d", row.ID)
		}
	}
	_ = h.Repo.Update(c.Request.Context(), row)
	h.Resolver.InvalidateAll(c.Request.Context())
	c.JSON(http.StatusCreated, row)
}

func (h *AssetGroupHandler) Update(c *gin.Context) {
	id, _ := strconv.ParseUint(c.Param("id"), 10, 64)
	row, err := h.Repo.FindByID(c.Request.Context(), id)
	if err != nil || row == nil {
		c.JSON(http.StatusNotFound, gin.H{"error": "not found"})
		return
	}
	var p assetGroupPayload
	if err := c.ShouldBindJSON(&p); err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"error": err.Error()})
		return
	}
	if p.Name != "" {
		row.Name = p.Name
	}
	row.Description = p.Description
	if err := h.Repo.Update(c.Request.Context(), row); err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": err.Error()})
		return
	}
	h.Resolver.InvalidateAll(c.Request.Context())
	c.JSON(http.StatusOK, row)
}

func (h *AssetGroupHandler) Delete(c *gin.Context) {
	id, _ := strconv.ParseUint(c.Param("id"), 10, 64)
	if err := h.Repo.Delete(c.Request.Context(), id); err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": err.Error()})
		return
	}
	h.Resolver.InvalidateAll(c.Request.Context())
	c.JSON(http.StatusOK, gin.H{"ok": true})
}

// Move reparents a group (drag-and-drop / "move to…"). parent_id null = top
// level. Returns 400 on a cycle-creating move so the UI can surface it.
func (h *AssetGroupHandler) Move(c *gin.Context) {
	id, _ := strconv.ParseUint(c.Param("id"), 10, 64)
	var body struct {
		ParentID *uint64 `json:"parent_id"`
	}
	if err := c.ShouldBindJSON(&body); err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"error": err.Error()})
		return
	}
	if err := h.Repo.Move(c.Request.Context(), id, body.ParentID); err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"error": err.Error()})
		return
	}
	h.Resolver.InvalidateAll(c.Request.Context())
	row, _ := h.Repo.FindByID(c.Request.Context(), id)
	c.JSON(http.StatusOK, row)
}

func (h *AssetGroupHandler) AddNode(c *gin.Context) {
	gid, _ := strconv.ParseUint(c.Param("id"), 10, 64)
	var body struct {
		NodeID uint64 `json:"node_id"`
	}
	if err := c.ShouldBindJSON(&body); err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"error": err.Error()})
		return
	}
	if err := h.Repo.AddNode(c.Request.Context(), gid, body.NodeID); err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": err.Error()})
		return
	}
	h.Resolver.InvalidateAll(c.Request.Context())
	c.JSON(http.StatusOK, gin.H{"ok": true})
}

func (h *AssetGroupHandler) RemoveNode(c *gin.Context) {
	gid, _ := strconv.ParseUint(c.Param("id"), 10, 64)
	nid, _ := strconv.ParseUint(c.Param("nid"), 10, 64)
	if err := h.Repo.RemoveNode(c.Request.Context(), gid, nid); err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": err.Error()})
		return
	}
	h.Resolver.InvalidateAll(c.Request.Context())
	c.JSON(http.StatusOK, gin.H{"ok": true})
}

// batchNodeIDs is the shared body for the tree's bulk membership/tag actions.
type batchNodeIDs struct {
	NodeIDs []uint64 `json:"node_ids"`
}

// batchFailure reports one id that couldn't be processed, so partial success is
// surfaced rather than swallowed.
type batchFailure struct {
	ID    uint64 `json:"id"`
	Error string `json:"error"`
}

// AddNodesBatch attaches many nodes to a group in one request — the tree's bulk
// "加入分组" action. Partial failures are reported, not fatal.
func (h *AssetGroupHandler) AddNodesBatch(c *gin.Context) {
	gid, _ := strconv.ParseUint(c.Param("id"), 10, 64)
	var body batchNodeIDs
	if err := c.ShouldBindJSON(&body); err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"error": err.Error()})
		return
	}
	if len(body.NodeIDs) == 0 {
		c.JSON(http.StatusBadRequest, gin.H{"error": "node_ids 不能为空"})
		return
	}
	ctx := c.Request.Context()
	ok := 0
	failed := []batchFailure{}
	for _, nid := range body.NodeIDs {
		if err := h.Repo.AddNode(ctx, gid, nid); err != nil {
			failed = append(failed, batchFailure{ID: nid, Error: err.Error()})
			continue
		}
		ok++
	}
	h.Resolver.InvalidateAll(ctx)
	c.JSON(http.StatusOK, gin.H{"ok": ok, "failed": failed})
}

// RemoveNodesBatch detaches many nodes from a group in one request (bulk "移出分组").
func (h *AssetGroupHandler) RemoveNodesBatch(c *gin.Context) {
	gid, _ := strconv.ParseUint(c.Param("id"), 10, 64)
	var body batchNodeIDs
	if err := c.ShouldBindJSON(&body); err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"error": err.Error()})
		return
	}
	if len(body.NodeIDs) == 0 {
		c.JSON(http.StatusBadRequest, gin.H{"error": "node_ids 不能为空"})
		return
	}
	ctx := c.Request.Context()
	ok := 0
	failed := []batchFailure{}
	for _, nid := range body.NodeIDs {
		if err := h.Repo.RemoveNode(ctx, gid, nid); err != nil {
			failed = append(failed, batchFailure{ID: nid, Error: err.Error()})
			continue
		}
		ok++
	}
	h.Resolver.InvalidateAll(ctx)
	c.JSON(http.StatusOK, gin.H{"ok": ok, "failed": failed})
}

// ----- Tags -----

type TagHandler struct {
	Repo     *repo.TagRepo
	Groups   *repo.TagGroupRepo
	Resolver *asset.Resolver
}

type tagPayload struct {
	Name        string  `json:"name"`
	Color       string  `json:"color"`
	Icon        string  `json:"icon"`
	Description string  `json:"description"`
	GroupID     *uint64 `json:"group_id"`
}

// tagView decorates a stored tag with its live usage count (number of nodes
// carrying it) so the management UI can show "× N" without a second request.
type tagView struct {
	model.AssetTag
	Count int `json:"count"`
}

func (h *TagHandler) List(c *gin.Context) {
	ctx := c.Request.Context()
	rows, err := h.Repo.List(ctx)
	if err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": err.Error()})
		return
	}
	counts, _ := h.Repo.Counts(ctx)
	views := make([]tagView, 0, len(rows))
	for _, t := range rows {
		views = append(views, tagView{AssetTag: t, Count: counts[t.ID]})
	}
	var groups []model.AssetTagGroup
	if h.Groups != nil {
		groups, _ = h.Groups.List(ctx)
	}
	c.JSON(http.StatusOK, gin.H{"tags": views, "groups": groups})
}

func (h *TagHandler) Create(c *gin.Context) {
	var p tagPayload
	if err := c.ShouldBindJSON(&p); err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"error": err.Error()})
		return
	}
	if strings.TrimSpace(p.Name) == "" {
		c.JSON(http.StatusBadRequest, gin.H{"error": "标签名称不能为空"})
		return
	}
	row := &model.AssetTag{
		Name:        strings.TrimSpace(p.Name),
		Color:       p.Color,
		Icon:        p.Icon,
		Description: p.Description,
		GroupID:     p.GroupID,
	}
	if err := h.Repo.Create(c.Request.Context(), row); err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": err.Error()})
		return
	}
	c.JSON(http.StatusCreated, row)
}

func (h *TagHandler) Update(c *gin.Context) {
	id, _ := strconv.ParseUint(c.Param("id"), 10, 64)
	var p tagPayload
	if err := c.ShouldBindJSON(&p); err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"error": err.Error()})
		return
	}
	if strings.TrimSpace(p.Name) == "" {
		c.JSON(http.StatusBadRequest, gin.H{"error": "标签名称不能为空"})
		return
	}
	row := &model.AssetTag{
		ID:          id,
		Name:        strings.TrimSpace(p.Name),
		Color:       p.Color,
		Icon:        p.Icon,
		Description: p.Description,
		GroupID:     p.GroupID,
	}
	if err := h.Repo.Update(c.Request.Context(), row); err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": err.Error()})
		return
	}
	// A rename changes the denormalised nodes.tags cache for every node carrying
	// it; refresh those and bust the auth resolver (tag→node grants depend on it).
	if nodeIDs, e := h.Repo.NodesWithTag(c.Request.Context(), []uint64{id}); e == nil {
		for _, nid := range nodeIDs {
			_ = h.Repo.AttachToNode(c.Request.Context(), nid, id) // idempotent; resyncs cache
		}
	}
	h.Resolver.InvalidateAll(c.Request.Context())
	c.JSON(http.StatusOK, row)
}

func (h *TagHandler) Delete(c *gin.Context) {
	id, _ := strconv.ParseUint(c.Param("id"), 10, 64)
	if err := h.Repo.Delete(c.Request.Context(), id); err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": err.Error()})
		return
	}
	h.Resolver.InvalidateAll(c.Request.Context())
	c.JSON(http.StatusOK, gin.H{"ok": true})
}

func (h *TagHandler) Attach(c *gin.Context) {
	nid, _ := strconv.ParseUint(c.Param("id"), 10, 64)
	var body struct {
		TagID uint64 `json:"tag_id"`
	}
	if err := c.ShouldBindJSON(&body); err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"error": err.Error()})
		return
	}
	if err := h.Repo.AttachToNode(c.Request.Context(), nid, body.TagID); err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": err.Error()})
		return
	}
	h.Resolver.InvalidateAll(c.Request.Context())
	c.JSON(http.StatusOK, gin.H{"ok": true})
}

func (h *TagHandler) Detach(c *gin.Context) {
	nid, _ := strconv.ParseUint(c.Param("id"), 10, 64)
	tid, _ := strconv.ParseUint(c.Param("tid"), 10, 64)
	if err := h.Repo.DetachFromNode(c.Request.Context(), nid, tid); err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": err.Error()})
		return
	}
	h.Resolver.InvalidateAll(c.Request.Context())
	c.JSON(http.StatusOK, gin.H{"ok": true})
}

// Replace sets a node's managed tags to exactly the supplied set (the tag
// picker's save action). Empty / missing tag_ids clears all tags.
func (h *TagHandler) Replace(c *gin.Context) {
	nid, _ := strconv.ParseUint(c.Param("id"), 10, 64)
	var body struct {
		TagIDs []uint64 `json:"tag_ids"`
	}
	if err := c.ShouldBindJSON(&body); err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"error": err.Error()})
		return
	}
	if err := h.Repo.ReplaceNodeTags(c.Request.Context(), nid, body.TagIDs); err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": err.Error()})
		return
	}
	h.Resolver.InvalidateAll(c.Request.Context())
	c.JSON(http.StatusOK, gin.H{"ok": true})
}

// AttachBatch puts one tag on many nodes at once — the tree's bulk "打标签"
// action. The tag id comes from the path; node ids from the body.
func (h *TagHandler) AttachBatch(c *gin.Context) {
	tid, _ := strconv.ParseUint(c.Param("id"), 10, 64)
	var body batchNodeIDs
	if err := c.ShouldBindJSON(&body); err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"error": err.Error()})
		return
	}
	if len(body.NodeIDs) == 0 {
		c.JSON(http.StatusBadRequest, gin.H{"error": "node_ids 不能为空"})
		return
	}
	ctx := c.Request.Context()
	ok := 0
	failed := []batchFailure{}
	for _, nid := range body.NodeIDs {
		if err := h.Repo.AttachToNode(ctx, nid, tid); err != nil {
			failed = append(failed, batchFailure{ID: nid, Error: err.Error()})
			continue
		}
		ok++
	}
	h.Resolver.InvalidateAll(ctx)
	c.JSON(http.StatusOK, gin.H{"ok": ok, "failed": failed})
}

// DetachBatch removes one tag from many nodes at once (bulk "去标签").
func (h *TagHandler) DetachBatch(c *gin.Context) {
	tid, _ := strconv.ParseUint(c.Param("id"), 10, 64)
	var body batchNodeIDs
	if err := c.ShouldBindJSON(&body); err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"error": err.Error()})
		return
	}
	if len(body.NodeIDs) == 0 {
		c.JSON(http.StatusBadRequest, gin.H{"error": "node_ids 不能为空"})
		return
	}
	ctx := c.Request.Context()
	ok := 0
	failed := []batchFailure{}
	for _, nid := range body.NodeIDs {
		if err := h.Repo.DetachFromNode(ctx, nid, tid); err != nil {
			failed = append(failed, batchFailure{ID: nid, Error: err.Error()})
			continue
		}
		ok++
	}
	h.Resolver.InvalidateAll(ctx)
	c.JSON(http.StatusOK, gin.H{"ok": ok, "failed": failed})
}

// ----- Tag groups -----

type TagGroupHandler struct {
	Repo *repo.TagGroupRepo
}

type tagGroupPayload struct {
	Name      string `json:"name"`
	Color     string `json:"color"`
	Icon      string `json:"icon"`
	SortOrder int    `json:"sort_order"`
}

func (h *TagGroupHandler) List(c *gin.Context) {
	rows, err := h.Repo.List(c.Request.Context())
	if err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": err.Error()})
		return
	}
	c.JSON(http.StatusOK, gin.H{"groups": rows})
}

func (h *TagGroupHandler) Create(c *gin.Context) {
	var p tagGroupPayload
	if err := c.ShouldBindJSON(&p); err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"error": err.Error()})
		return
	}
	if strings.TrimSpace(p.Name) == "" {
		c.JSON(http.StatusBadRequest, gin.H{"error": "分组名称不能为空"})
		return
	}
	row := &model.AssetTagGroup{
		Name:      strings.TrimSpace(p.Name),
		Color:     p.Color,
		Icon:      p.Icon,
		SortOrder: p.SortOrder,
	}
	if err := h.Repo.Create(c.Request.Context(), row); err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": err.Error()})
		return
	}
	c.JSON(http.StatusCreated, row)
}

func (h *TagGroupHandler) Update(c *gin.Context) {
	id, _ := strconv.ParseUint(c.Param("id"), 10, 64)
	var p tagGroupPayload
	if err := c.ShouldBindJSON(&p); err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"error": err.Error()})
		return
	}
	row := &model.AssetTagGroup{
		ID:        id,
		Name:      strings.TrimSpace(p.Name),
		Color:     p.Color,
		Icon:      p.Icon,
		SortOrder: p.SortOrder,
	}
	if err := h.Repo.Update(c.Request.Context(), row); err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": err.Error()})
		return
	}
	c.JSON(http.StatusOK, row)
}

func (h *TagGroupHandler) Delete(c *gin.Context) {
	id, _ := strconv.ParseUint(c.Param("id"), 10, 64)
	if err := h.Repo.Delete(c.Request.Context(), id); err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": err.Error()})
		return
	}
	c.JSON(http.StatusOK, gin.H{"ok": true})
}

// ----- Asset grants -----

type GrantHandler struct {
	Repo     *repo.GrantRepo
	Resolver *asset.Resolver
}

type grantPayload struct {
	GranteeType model.GranteeType `json:"grantee_type"`
	GranteeID   uint64            `json:"grantee_id"`
	SubjectType model.SubjectType `json:"subject_type"`
	SubjectID   uint64            `json:"subject_id"`
	Actions     string            `json:"actions"`
	ValidFrom   string            `json:"valid_from"`
	ValidTo     string            `json:"valid_to"`
}

func (h *GrantHandler) List(c *gin.Context) {
	rows, err := h.Repo.List(c.Request.Context())
	if err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": err.Error()})
		return
	}
	c.JSON(http.StatusOK, gin.H{"grants": rows})
}

func (h *GrantHandler) Create(c *gin.Context) {
	var p grantPayload
	if err := c.ShouldBindJSON(&p); err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"error": err.Error()})
		return
	}
	claims := auth.FromContext(c.Request.Context())
	row := &model.AssetGrant{
		GranteeType: p.GranteeType, GranteeID: p.GranteeID,
		SubjectType: p.SubjectType, SubjectID: p.SubjectID,
		Actions: p.Actions, Source: "manual",
		ValidFrom: parseGrantTime(p.ValidFrom),
		ValidTo:   parseGrantTime(p.ValidTo),
	}
	if claims != nil {
		row.CreatedBy = claims.UserID
	}
	if err := h.Repo.Create(c.Request.Context(), row); err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": err.Error()})
		return
	}
	h.Resolver.InvalidateAll(c.Request.Context())
	c.JSON(http.StatusCreated, row)
}

type grantSubjectRef struct {
	Type model.SubjectType `json:"type"`
	ID   uint64            `json:"id"`
}

type grantBatchPayload struct {
	Grantees  []asset.GranteeRef `json:"grantees"`
	Subjects  []grantSubjectRef  `json:"subjects"`
	Actions   string             `json:"actions"`
	ValidFrom string             `json:"valid_from"`
	ValidTo   string             `json:"valid_to"`
}

// CreateBatch authorises every (grantee × subject) pair in one request — the
// backbone of the 授权向导, so granting many people access to many assets is a
// single action instead of N dialogs.
func (h *GrantHandler) CreateBatch(c *gin.Context) {
	var p grantBatchPayload
	if err := c.ShouldBindJSON(&p); err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"error": err.Error()})
		return
	}
	if len(p.Grantees) == 0 || len(p.Subjects) == 0 || strings.TrimSpace(p.Actions) == "" {
		c.JSON(http.StatusBadRequest, gin.H{"error": "需要至少一个授权对象、一个资产和一项权限"})
		return
	}
	claims := auth.FromContext(c.Request.Context())
	var by uint64
	if claims != nil {
		by = claims.UserID
	}
	vf := parseGrantTime(p.ValidFrom)
	vt := parseGrantTime(p.ValidTo)
	created := 0
	for _, gr := range p.Grantees {
		for _, sub := range p.Subjects {
			sid := sub.ID
			if sub.Type == model.SubjectAll {
				sid = 0
			}
			row := &model.AssetGrant{
				GranteeType: gr.Type, GranteeID: gr.ID,
				SubjectType: sub.Type, SubjectID: sid,
				Actions: p.Actions, Source: "manual", CreatedBy: by,
				ValidFrom: vf, ValidTo: vt,
			}
			if err := h.Repo.Create(c.Request.Context(), row); err != nil {
				continue
			}
			created++
		}
	}
	h.Resolver.InvalidateAll(c.Request.Context())
	c.JSON(http.StatusCreated, gin.H{"created": created})
}

// ByGrantee answers 按人看: what this grantee can actually reach (a user is
// resolved through their groups / roles / department), with sources.
func (h *GrantHandler) ByGrantee(c *gin.Context) {
	gt := model.GranteeType(c.Query("type"))
	id, _ := strconv.ParseUint(c.Query("id"), 10, 64)
	if id == 0 || gt == "" {
		c.JSON(http.StatusBadRequest, gin.H{"error": "缺少 type / id"})
		return
	}
	exp, err := h.Resolver.Explain(c.Request.Context(), gt, id)
	if err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": err.Error()})
		return
	}
	c.JSON(http.StatusOK, exp)
}

// BySubject answers 按资产看: every grantee that can reach a node, and how.
func (h *GrantHandler) BySubject(c *gin.Context) {
	nodeID, _ := strconv.ParseUint(c.Query("node_id"), 10, 64)
	if nodeID == 0 {
		c.JSON(http.StatusBadRequest, gin.H{"error": "缺少 node_id"})
		return
	}
	rows, err := h.Resolver.WhoCanAccessNode(c.Request.Context(), nodeID)
	if err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": err.Error()})
		return
	}
	c.JSON(http.StatusOK, gin.H{"grantees": rows})
}

// parseGrantTime accepts RFC3339, "YYYY-MM-DDTHH:MM" (datetime-local), or a bare
// date. Empty / unparseable → nil (no bound).
func parseGrantTime(s string) *time.Time {
	s = strings.TrimSpace(s)
	if s == "" {
		return nil
	}
	for _, layout := range []string{time.RFC3339, "2006-01-02T15:04", "2006-01-02"} {
		if t, err := time.Parse(layout, s); err == nil {
			return &t
		}
	}
	return nil
}

func (h *GrantHandler) Delete(c *gin.Context) {
	id, _ := strconv.ParseUint(c.Param("id"), 10, 64)
	if err := h.Repo.Delete(c.Request.Context(), id); err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": err.Error()})
		return
	}
	h.Resolver.InvalidateAll(c.Request.Context())
	c.JSON(http.StatusOK, gin.H{"ok": true})
}
