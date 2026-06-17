package api

import (
	"net/http"
	"strconv"
	"strings"

	"github.com/gin-gonic/gin"
	"github.com/michongs/wayfort/internal/asset"
	"github.com/michongs/wayfort/internal/auth"
	"github.com/michongs/wayfort/internal/model"
	"github.com/michongs/wayfort/internal/repo"
)

// AccessTreeHandler serves the 授权目录 — each authorisation object (user /
// group / department) owns a folder tree of assets with inline permissions, and
// editing it IS authorising that object. Unified with the flat grant model: the
// Resolver merges tree-derived access with AssetGrant, and these endpoints share
// the grant:manage permission. Every mutation flushes the ACL cache.
type AccessTreeHandler struct {
	Folders   *repo.AccessFolderRepo
	Items     *repo.AccessItemRepo
	Templates *repo.AccessTemplateRepo
	Nodes     *repo.NodeRepo
	Resolver  *asset.Resolver
}

func (h *AccessTreeHandler) invalidate(c *gin.Context) { h.Resolver.InvalidateAll(c.Request.Context()) }

// validOwnerType limits tree ownership to user / group / department, plus the
// synthetic "template" owner (templates grant nobody but are editable trees).
func validOwnerType(t model.GranteeType) bool {
	return t == model.GranteeUser || t == model.GranteeGroup || t == model.GranteeDepartment || t == model.OwnerTemplate
}

// ----- Admin: read an object's tree -----

type accessTreeView struct {
	Folders []model.AccessFolder `json:"folders"`
	Items   []model.AccessItem   `json:"items"`
}

func (h *AccessTreeHandler) Get(c *gin.Context) {
	ot := model.GranteeType(c.Query("owner_type"))
	oid, _ := strconv.ParseUint(c.Query("owner_id"), 10, 64)
	if !validOwnerType(ot) || oid == 0 {
		c.JSON(http.StatusBadRequest, gin.H{"error": "缺少或非法的 owner_type / owner_id"})
		return
	}
	ctx := c.Request.Context()
	folders, err := h.Folders.ListByOwner(ctx, ot, oid)
	if err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": err.Error()})
		return
	}
	items, err := h.Items.ListByOwner(ctx, ot, oid)
	if err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": err.Error()})
		return
	}
	c.JSON(http.StatusOK, accessTreeView{Folders: folders, Items: items})
}

// ----- Folders -----

type folderPayload struct {
	OwnerType model.GranteeType `json:"owner_type"`
	OwnerID   uint64            `json:"owner_id"`
	Name      string            `json:"name"`
	ParentID  *uint64           `json:"parent_id"`
	Icon      string            `json:"icon"`
	Actions   string            `json:"actions"` // "" = inherit
	ValidFrom string            `json:"valid_from"`
	ValidTo   string            `json:"valid_to"`
}

func (h *AccessTreeHandler) CreateFolder(c *gin.Context) {
	var p folderPayload
	if err := c.ShouldBindJSON(&p); err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"error": err.Error()})
		return
	}
	if !validOwnerType(p.OwnerType) || p.OwnerID == 0 || strings.TrimSpace(p.Name) == "" {
		c.JSON(http.StatusBadRequest, gin.H{"error": "需要 owner_type / owner_id / name"})
		return
	}
	row := &model.AccessFolder{
		OwnerType: p.OwnerType, OwnerID: p.OwnerID, Name: p.Name, ParentID: p.ParentID,
		Icon: p.Icon, Actions: p.Actions, ValidFrom: parseGrantTime(p.ValidFrom), ValidTo: parseGrantTime(p.ValidTo),
	}
	if err := h.Folders.Create(c.Request.Context(), row); err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": err.Error()})
		return
	}
	h.invalidate(c)
	c.JSON(http.StatusCreated, row)
}

func (h *AccessTreeHandler) UpdateFolder(c *gin.Context) {
	id, _ := strconv.ParseUint(c.Param("id"), 10, 64)
	f, err := h.Folders.FindByID(c.Request.Context(), id)
	if err != nil || f == nil {
		c.JSON(http.StatusNotFound, gin.H{"error": "not found"})
		return
	}
	var p folderPayload
	if err := c.ShouldBindJSON(&p); err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"error": err.Error()})
		return
	}
	if p.Name != "" {
		f.Name = p.Name
	}
	f.Icon = p.Icon
	f.Actions = p.Actions
	f.ValidFrom = parseGrantTime(p.ValidFrom)
	f.ValidTo = parseGrantTime(p.ValidTo)
	if err := h.Folders.Update(c.Request.Context(), f); err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": err.Error()})
		return
	}
	h.invalidate(c)
	c.JSON(http.StatusOK, f)
}

func (h *AccessTreeHandler) MoveFolder(c *gin.Context) {
	id, _ := strconv.ParseUint(c.Param("id"), 10, 64)
	var body struct {
		ParentID *uint64 `json:"parent_id"`
	}
	if err := c.ShouldBindJSON(&body); err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"error": err.Error()})
		return
	}
	if err := h.Folders.Move(c.Request.Context(), id, body.ParentID); err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"error": err.Error()})
		return
	}
	h.invalidate(c)
	c.JSON(http.StatusOK, gin.H{"ok": true})
}

func (h *AccessTreeHandler) DeleteFolder(c *gin.Context) {
	id, _ := strconv.ParseUint(c.Param("id"), 10, 64)
	if err := h.Folders.Delete(c.Request.Context(), id); err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": err.Error()})
		return
	}
	h.invalidate(c)
	c.JSON(http.StatusOK, gin.H{"ok": true})
}

// ----- Items -----

type itemPayload struct {
	OwnerType model.GranteeType `json:"owner_type"`
	OwnerID   uint64            `json:"owner_id"`
	FolderID  uint64            `json:"folder_id"`
	NodeIDs   []uint64          `json:"node_ids"`
	Actions   string            `json:"actions"` // "" = inherit folder
	ValidFrom string            `json:"valid_from"`
	ValidTo   string            `json:"valid_to"`
}

func (h *AccessTreeHandler) AddItems(c *gin.Context) {
	var p itemPayload
	if err := c.ShouldBindJSON(&p); err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"error": err.Error()})
		return
	}
	if !validOwnerType(p.OwnerType) || p.OwnerID == 0 || p.FolderID == 0 || len(p.NodeIDs) == 0 {
		c.JSON(http.StatusBadRequest, gin.H{"error": "需要 owner / folder_id / node_ids"})
		return
	}
	vf, vt := parseGrantTime(p.ValidFrom), parseGrantTime(p.ValidTo)
	added := 0
	for _, nid := range p.NodeIDs {
		it := &model.AccessItem{
			OwnerType: p.OwnerType, OwnerID: p.OwnerID, FolderID: p.FolderID, NodeID: nid,
			Actions: p.Actions, ValidFrom: vf, ValidTo: vt,
		}
		if err := h.Items.Add(c.Request.Context(), it); err == nil {
			added++
		}
	}
	h.invalidate(c)
	c.JSON(http.StatusCreated, gin.H{"added": added})
}

// itemUpdatePayload uses pointers so a move (folder_id only) doesn't wipe the
// item's permission override, and a permission edit doesn't move it.
type itemUpdatePayload struct {
	Actions   *string `json:"actions"`
	ValidFrom *string `json:"valid_from"`
	ValidTo   *string `json:"valid_to"`
	FolderID  *uint64 `json:"folder_id"` // re-home the item into another folder (drag)
}

func (h *AccessTreeHandler) UpdateItem(c *gin.Context) {
	id, _ := strconv.ParseUint(c.Param("id"), 10, 64)
	it, err := h.Items.FindByID(c.Request.Context(), id)
	if err != nil || it == nil {
		c.JSON(http.StatusNotFound, gin.H{"error": "not found"})
		return
	}
	var p itemUpdatePayload
	if err := c.ShouldBindJSON(&p); err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"error": err.Error()})
		return
	}
	if p.Actions != nil {
		it.Actions = *p.Actions
	}
	if p.ValidFrom != nil {
		it.ValidFrom = parseGrantTime(*p.ValidFrom)
	}
	if p.ValidTo != nil {
		it.ValidTo = parseGrantTime(*p.ValidTo)
	}
	// Move: only into a folder owned by the same object.
	if p.FolderID != nil && *p.FolderID != 0 && *p.FolderID != it.FolderID {
		f, err := h.Folders.FindByID(c.Request.Context(), *p.FolderID)
		if err == nil && f != nil && f.OwnerType == it.OwnerType && f.OwnerID == it.OwnerID {
			it.FolderID = *p.FolderID
		}
	}
	if err := h.Items.Update(c.Request.Context(), it); err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": err.Error()})
		return
	}
	h.invalidate(c)
	c.JSON(http.StatusOK, it)
}

func (h *AccessTreeHandler) DeleteItem(c *gin.Context) {
	id, _ := strconv.ParseUint(c.Param("id"), 10, 64)
	if err := h.Items.Remove(c.Request.Context(), id); err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": err.Error()})
		return
	}
	h.invalidate(c)
	c.JSON(http.StatusOK, gin.H{"ok": true})
}

// ----- Clone / template / subtree / reorder -----

type clonePayload struct {
	FromOwnerType model.GranteeType `json:"from_owner_type"`
	FromOwnerID   uint64            `json:"from_owner_id"`
	ToOwnerType   model.GranteeType `json:"to_owner_type"`
	ToOwnerID     uint64            `json:"to_owner_id"`
}

// Clone deep-copies one owner's (or template's) tree onto another object.
func (h *AccessTreeHandler) Clone(c *gin.Context) {
	var p clonePayload
	if err := c.ShouldBindJSON(&p); err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"error": err.Error()})
		return
	}
	if !validOwnerType(p.FromOwnerType) || p.FromOwnerID == 0 || !validOwnerType(p.ToOwnerType) || p.ToOwnerID == 0 {
		c.JSON(http.StatusBadRequest, gin.H{"error": "缺少来源 / 目标对象"})
		return
	}
	if err := h.Folders.CopyTree(c.Request.Context(), p.FromOwnerType, p.FromOwnerID, p.ToOwnerType, p.ToOwnerID); err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": err.Error()})
		return
	}
	h.invalidate(c)
	c.JSON(http.StatusOK, gin.H{"ok": true})
}

// ApplySubtree pushes a folder's actions + validity down its whole subtree.
func (h *AccessTreeHandler) ApplySubtree(c *gin.Context) {
	id, _ := strconv.ParseUint(c.Param("id"), 10, 64)
	f, err := h.Folders.FindByID(c.Request.Context(), id)
	if err != nil || f == nil {
		c.JSON(http.StatusNotFound, gin.H{"error": "not found"})
		return
	}
	var p struct {
		Actions string `json:"actions"`
		ValidTo string `json:"valid_to"`
	}
	if err := c.ShouldBindJSON(&p); err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"error": err.Error()})
		return
	}
	if err := h.Folders.ApplySubtreePerm(c.Request.Context(), f.OwnerType, f.OwnerID, id, p.Actions, parseGrantTime(p.ValidTo)); err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": err.Error()})
		return
	}
	h.invalidate(c)
	c.JSON(http.StatusOK, gin.H{"ok": true})
}

// Reorder persists drag-reordering of siblings (no ACL impact).
func (h *AccessTreeHandler) Reorder(c *gin.Context) {
	var p struct {
		Kind string   `json:"kind"` // "folder" | "item"
		IDs  []uint64 `json:"ids"`
	}
	if err := c.ShouldBindJSON(&p); err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"error": err.Error()})
		return
	}
	var err error
	if p.Kind == "folder" {
		err = h.Folders.SetSortOrder(c.Request.Context(), p.IDs)
	} else {
		err = h.Items.SetSortOrder(c.Request.Context(), p.IDs)
	}
	if err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": err.Error()})
		return
	}
	c.JSON(http.StatusOK, gin.H{"ok": true})
}

func (h *AccessTreeHandler) ListTemplates(c *gin.Context) {
	rows, err := h.Templates.List(c.Request.Context())
	if err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": err.Error()})
		return
	}
	c.JSON(http.StatusOK, gin.H{"templates": rows})
}

// CreateTemplate makes a named template, optionally seeded from an object's tree.
func (h *AccessTreeHandler) CreateTemplate(c *gin.Context) {
	var p struct {
		Name          string            `json:"name"`
		Description   string            `json:"description"`
		FromOwnerType model.GranteeType `json:"from_owner_type"`
		FromOwnerID   uint64            `json:"from_owner_id"`
	}
	if err := c.ShouldBindJSON(&p); err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"error": err.Error()})
		return
	}
	if strings.TrimSpace(p.Name) == "" {
		c.JSON(http.StatusBadRequest, gin.H{"error": "模板名称必填"})
		return
	}
	claims := auth.FromContext(c.Request.Context())
	t := &model.AccessTemplate{Name: p.Name, Description: p.Description}
	if claims != nil {
		t.CreatedBy = claims.UserID
	}
	if err := h.Templates.Create(c.Request.Context(), t); err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": err.Error()})
		return
	}
	if validOwnerType(p.FromOwnerType) && p.FromOwnerID != 0 {
		_ = h.Folders.CopyTree(c.Request.Context(), p.FromOwnerType, p.FromOwnerID, model.OwnerTemplate, t.ID)
	}
	c.JSON(http.StatusCreated, t)
}

func (h *AccessTreeHandler) DeleteTemplate(c *gin.Context) {
	id, _ := strconv.ParseUint(c.Param("id"), 10, 64)
	if err := h.Templates.Delete(c.Request.Context(), id); err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": err.Error()})
		return
	}
	_ = h.Folders.PurgeOwner(c.Request.Context(), model.OwnerTemplate, id)
	c.JSON(http.StatusOK, gin.H{"ok": true})
}

// ----- User-facing: GET /me/directory -----

type myDirFolderView struct {
	ID        uint64  `json:"id"`
	ParentID  *uint64 `json:"parent_id,omitempty"`
	Name      string  `json:"name"`
	Path      string  `json:"path"`
	Icon      string  `json:"icon"`
	SortOrder int     `json:"sort_order"`
}
type myDirItemView struct {
	FolderID  uint64 `json:"folder_id"`
	NodeID    uint64 `json:"node_id"`
	SortOrder int    `json:"sort_order"`
}

// MyDirectory returns the merged authorisation tree reaching the current user
// (their own tree plus inherited group / department trees), filtered to nodes
// they can connect to and with empty folders pruned — so it never leaks assets
// beyond the grant. The frontend joins item node_id against /me/nodes.
func (h *AccessTreeHandler) MyDirectory(c *gin.Context) {
	ctx := c.Request.Context()
	claims := auth.FromContext(ctx)
	connIDs, all, err := h.Resolver.VisibleNodeIDs(ctx, claims.UserID, asset.ActionConnect)
	if err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": err.Error()})
		return
	}
	connectable := make(map[uint64]bool, len(connIDs))
	for _, id := range connIDs {
		connectable[id] = true
	}

	folders, items, err := h.Resolver.DirectoryForUser(ctx, claims.UserID)
	if err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": err.Error()})
		return
	}

	// Visible items: connectable nodes only.
	visItems := make([]myDirItemView, 0, len(items))
	folderHasVisible := map[uint64]bool{}
	for _, it := range items {
		if !all && !connectable[it.NodeID] {
			continue
		}
		visItems = append(visItems, myDirItemView{FolderID: it.FolderID, NodeID: it.NodeID, SortOrder: it.SortOrder})
		folderHasVisible[it.FolderID] = true
	}

	// Keep a folder iff it (or a descendant) holds a visible item: for each
	// folder that directly holds one, mark its whole ancestor chain (path ids).
	keep := map[uint64]bool{}
	for _, f := range folders {
		if !folderHasVisible[f.ID] {
			continue
		}
		for _, seg := range strings.Split(f.Path, "/") {
			if seg == "" {
				continue
			}
			if fid, e := strconv.ParseUint(seg, 10, 64); e == nil {
				keep[fid] = true
			}
		}
	}
	visFolders := make([]myDirFolderView, 0, len(folders))
	for _, f := range folders {
		if !keep[f.ID] {
			continue
		}
		visFolders = append(visFolders, myDirFolderView{ID: f.ID, ParentID: f.ParentID, Name: f.Name, Path: f.Path, Icon: f.Icon, SortOrder: f.SortOrder})
	}
	c.JSON(http.StatusOK, gin.H{"folders": visFolders, "items": visItems})
}
