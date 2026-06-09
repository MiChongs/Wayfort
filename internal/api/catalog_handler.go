package api

import (
	"net/http"
	"strconv"
	"strings"

	"github.com/gin-gonic/gin"
	"github.com/michongs/jumpserver-anonymous/internal/asset"
	"github.com/michongs/jumpserver-anonymous/internal/auth"
	"github.com/michongs/jumpserver-anonymous/internal/model"
	"github.com/michongs/jumpserver-anonymous/internal/repo"
)

// CatalogHandler serves the 授权目录 (custom authorisation directory) admin
// surface plus the user-facing GET /me/catalogs. Catalogs are independent of the
// global asset tree; every mutation invalidates the resolver cache so the new
// shape is enforced within the next access check.
type CatalogHandler struct {
	Catalogs    *repo.CatalogRepo
	Folders     *repo.CatalogFolderRepo
	Placements  *repo.CatalogPlacementRepo
	Assignments *repo.CatalogAssignmentRepo
	Nodes       *repo.NodeRepo
	Resolver    *asset.Resolver
}

func (h *CatalogHandler) invalidate(c *gin.Context) {
	h.Resolver.InvalidateAll(c.Request.Context())
}

// ----- Catalog CRUD -----

type catalogPayload struct {
	Name        string `json:"name"`
	Description string `json:"description"`
	Icon        string `json:"icon"`
	IsTemplate  bool   `json:"is_template"`
}

func (h *CatalogHandler) List(c *gin.Context) {
	rows, err := h.Catalogs.List(c.Request.Context())
	if err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": err.Error()})
		return
	}
	c.JSON(http.StatusOK, gin.H{"catalogs": rows})
}

func (h *CatalogHandler) Create(c *gin.Context) {
	var p catalogPayload
	if err := c.ShouldBindJSON(&p); err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"error": err.Error()})
		return
	}
	if strings.TrimSpace(p.Name) == "" {
		c.JSON(http.StatusBadRequest, gin.H{"error": "目录名称必填"})
		return
	}
	claims := auth.FromContext(c.Request.Context())
	row := &model.Catalog{Name: p.Name, Description: p.Description, Icon: p.Icon, IsTemplate: p.IsTemplate}
	if claims != nil {
		row.CreatedBy = claims.UserID
	}
	if err := h.Catalogs.Create(c.Request.Context(), row); err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": err.Error()})
		return
	}
	c.JSON(http.StatusCreated, row)
}

// catalogDetail is the full editor payload: the catalog plus its folder tree,
// placements (node_id only — the editor already holds the node list), and
// assignments.
type catalogDetail struct {
	Catalog     model.Catalog             `json:"catalog"`
	Folders     []model.CatalogFolder     `json:"folders"`
	Placements  []model.CatalogPlacement  `json:"placements"`
	Assignments []model.CatalogAssignment `json:"assignments"`
}

func (h *CatalogHandler) Get(c *gin.Context) {
	id, _ := strconv.ParseUint(c.Param("id"), 10, 64)
	ctx := c.Request.Context()
	cat, err := h.Catalogs.FindByID(ctx, id)
	if err != nil || cat == nil {
		c.JSON(http.StatusNotFound, gin.H{"error": "not found"})
		return
	}
	folders, err := h.Folders.ListByCatalog(ctx, id)
	if err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": err.Error()})
		return
	}
	placements, err := h.Placements.ListByCatalog(ctx, id)
	if err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": err.Error()})
		return
	}
	assignments, err := h.Assignments.ListByCatalog(ctx, id)
	if err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": err.Error()})
		return
	}
	c.JSON(http.StatusOK, catalogDetail{Catalog: *cat, Folders: folders, Placements: placements, Assignments: assignments})
}

func (h *CatalogHandler) Update(c *gin.Context) {
	id, _ := strconv.ParseUint(c.Param("id"), 10, 64)
	cat, err := h.Catalogs.FindByID(c.Request.Context(), id)
	if err != nil || cat == nil {
		c.JSON(http.StatusNotFound, gin.H{"error": "not found"})
		return
	}
	var p catalogPayload
	if err := c.ShouldBindJSON(&p); err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"error": err.Error()})
		return
	}
	if p.Name != "" {
		cat.Name = p.Name
	}
	cat.Description = p.Description
	cat.Icon = p.Icon
	cat.IsTemplate = p.IsTemplate
	if err := h.Catalogs.Update(c.Request.Context(), cat); err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": err.Error()})
		return
	}
	c.JSON(http.StatusOK, cat)
}

func (h *CatalogHandler) Delete(c *gin.Context) {
	id, _ := strconv.ParseUint(c.Param("id"), 10, 64)
	if err := h.Catalogs.Delete(c.Request.Context(), id); err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": err.Error()})
		return
	}
	h.invalidate(c)
	c.JSON(http.StatusOK, gin.H{"ok": true})
}

// ----- Folders -----

type folderPayload struct {
	Name        string  `json:"name"`
	ParentID    *uint64 `json:"parent_id"`
	Icon        string  `json:"icon"`
	Description string  `json:"description"`
}

func (h *CatalogHandler) CreateFolder(c *gin.Context) {
	cid, _ := strconv.ParseUint(c.Param("id"), 10, 64)
	var p folderPayload
	if err := c.ShouldBindJSON(&p); err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"error": err.Error()})
		return
	}
	if strings.TrimSpace(p.Name) == "" {
		c.JSON(http.StatusBadRequest, gin.H{"error": "文件夹名称必填"})
		return
	}
	row := &model.CatalogFolder{CatalogID: cid, Name: p.Name, ParentID: p.ParentID, Icon: p.Icon, Description: p.Description}
	if err := h.Folders.Create(c.Request.Context(), row); err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": err.Error()})
		return
	}
	c.JSON(http.StatusCreated, row)
}

func (h *CatalogHandler) UpdateFolder(c *gin.Context) {
	fid, _ := strconv.ParseUint(c.Param("fid"), 10, 64)
	f, err := h.Folders.FindByID(c.Request.Context(), fid)
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
	f.Description = p.Description
	if err := h.Folders.Update(c.Request.Context(), f); err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": err.Error()})
		return
	}
	c.JSON(http.StatusOK, f)
}

// MoveFolder reparents a folder (drag-and-drop). parent_id null = top level.
// Returns 400 on a cycle-creating or cross-catalog move.
func (h *CatalogHandler) MoveFolder(c *gin.Context) {
	fid, _ := strconv.ParseUint(c.Param("fid"), 10, 64)
	var body struct {
		ParentID *uint64 `json:"parent_id"`
	}
	if err := c.ShouldBindJSON(&body); err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"error": err.Error()})
		return
	}
	if err := h.Folders.Move(c.Request.Context(), fid, body.ParentID); err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"error": err.Error()})
		return
	}
	h.invalidate(c)
	c.JSON(http.StatusOK, gin.H{"ok": true})
}

func (h *CatalogHandler) DeleteFolder(c *gin.Context) {
	fid, _ := strconv.ParseUint(c.Param("fid"), 10, 64)
	if err := h.Folders.Delete(c.Request.Context(), fid); err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": err.Error()})
		return
	}
	h.invalidate(c)
	c.JSON(http.StatusOK, gin.H{"ok": true})
}

// ----- Placements -----

type placementPayload struct {
	FolderID uint64   `json:"folder_id"`
	NodeIDs  []uint64 `json:"node_ids"`
}

// AddPlacements drops one or more nodes into a folder. The same node may be
// placed in multiple folders (placements are non-unique across folders).
func (h *CatalogHandler) AddPlacements(c *gin.Context) {
	cid, _ := strconv.ParseUint(c.Param("id"), 10, 64)
	var p placementPayload
	if err := c.ShouldBindJSON(&p); err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"error": err.Error()})
		return
	}
	if p.FolderID == 0 || len(p.NodeIDs) == 0 {
		c.JSON(http.StatusBadRequest, gin.H{"error": "需要 folder_id 和至少一个 node_id"})
		return
	}
	added := 0
	for _, nid := range p.NodeIDs {
		if err := h.Placements.Add(c.Request.Context(), cid, p.FolderID, nid); err == nil {
			added++
		}
	}
	h.invalidate(c)
	c.JSON(http.StatusCreated, gin.H{"added": added})
}

func (h *CatalogHandler) DeletePlacement(c *gin.Context) {
	pid, _ := strconv.ParseUint(c.Param("pid"), 10, 64)
	if err := h.Placements.Remove(c.Request.Context(), pid); err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": err.Error()})
		return
	}
	h.invalidate(c)
	c.JSON(http.StatusOK, gin.H{"ok": true})
}

// ----- Assignments -----

type assignmentPayload struct {
	FolderID  *uint64            `json:"folder_id"` // nil = whole catalog
	Grantees  []asset.GranteeRef `json:"grantees"`
	Actions   string             `json:"actions"`
	ValidFrom string             `json:"valid_from"`
	ValidTo   string             `json:"valid_to"`
}

// CreateAssignments binds a catalog (or one folder subtree) to every supplied
// grantee in one request, mirroring the grant 向导's batch behaviour.
func (h *CatalogHandler) CreateAssignments(c *gin.Context) {
	cid, _ := strconv.ParseUint(c.Param("id"), 10, 64)
	var p assignmentPayload
	if err := c.ShouldBindJSON(&p); err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"error": err.Error()})
		return
	}
	if len(p.Grantees) == 0 || strings.TrimSpace(p.Actions) == "" {
		c.JSON(http.StatusBadRequest, gin.H{"error": "需要至少一个授权对象和一项权限"})
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
		row := &model.CatalogAssignment{
			CatalogID:   cid,
			FolderID:    p.FolderID,
			GranteeType: gr.Type,
			GranteeID:   gr.ID,
			Actions:     p.Actions,
			ValidFrom:   vf,
			ValidTo:     vt,
			CreatedBy:   by,
		}
		if err := h.Assignments.Create(c.Request.Context(), row); err == nil {
			created++
		}
	}
	h.invalidate(c)
	c.JSON(http.StatusCreated, gin.H{"created": created})
}

func (h *CatalogHandler) DeleteAssignment(c *gin.Context) {
	aid, _ := strconv.ParseUint(c.Param("aid"), 10, 64)
	if err := h.Assignments.Delete(c.Request.Context(), aid); err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": err.Error()})
		return
	}
	h.invalidate(c)
	c.JSON(http.StatusOK, gin.H{"ok": true})
}

// ----- User-facing: GET /me/catalogs -----

type myCatalogFolderView struct {
	ID        uint64  `json:"id"`
	ParentID  *uint64 `json:"parent_id,omitempty"`
	Name      string  `json:"name"`
	Path      string  `json:"path"`
	Icon      string  `json:"icon"`
	SortOrder int     `json:"sort_order"`
}

type myCatalogPlacementView struct {
	FolderID  uint64 `json:"folder_id"`
	NodeID    uint64 `json:"node_id"`
	SortOrder int    `json:"sort_order"`
}

type myCatalogView struct {
	ID          uint64                   `json:"id"`
	Name        string                   `json:"name"`
	Icon        string                   `json:"icon"`
	Description string                   `json:"description"`
	Folders     []myCatalogFolderView    `json:"folders"`
	Placements  []myCatalogPlacementView `json:"placements"`
}

// MyCatalogs returns the catalogs assigned to the current user as folder trees,
// filtered to the nodes the user can actually connect to and with empty folders
// pruned — so the directory never leaks assets beyond the grant. The frontend
// joins placement node_id against the /me/nodes set it already holds.
func (h *CatalogHandler) MyCatalogs(c *gin.Context) {
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

	assigns, err := h.Resolver.AssignmentsForUser(ctx, claims.UserID)
	if err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": err.Error()})
		return
	}
	if len(assigns) == 0 {
		c.JSON(http.StatusOK, gin.H{"catalogs": []any{}})
		return
	}

	// Per catalog: whether the whole catalog is in scope, plus the explicit
	// in-scope folder set (subtrees of folder-scoped assignments).
	type scope struct {
		whole     bool
		folderIDs map[uint64]bool
	}
	scopes := map[uint64]*scope{}
	order := make([]uint64, 0)
	for _, a := range assigns {
		s := scopes[a.CatalogID]
		if s == nil {
			s = &scope{folderIDs: map[uint64]bool{}}
			scopes[a.CatalogID] = s
			order = append(order, a.CatalogID)
		}
		if a.FolderID == nil {
			s.whole = true
			continue
		}
		f, err := h.Folders.FindByID(ctx, *a.FolderID)
		if err != nil || f == nil {
			continue
		}
		sub, err := h.Folders.Subtree(ctx, f.CatalogID, f.Path)
		if err != nil {
			continue
		}
		for _, x := range sub {
			s.folderIDs[x.ID] = true
		}
	}

	out := make([]myCatalogView, 0, len(order))
	for _, cid := range order {
		cat, err := h.Catalogs.FindByID(ctx, cid)
		if err != nil || cat == nil {
			continue
		}
		s := scopes[cid]
		inScope := func(fid uint64) bool { return s.whole || s.folderIDs[fid] }

		folders, err := h.Folders.ListByCatalog(ctx, cid)
		if err != nil {
			continue
		}
		placements, err := h.Placements.ListByCatalog(ctx, cid)
		if err != nil {
			continue
		}

		// Visible placements: in-scope folder + connectable node.
		visiblePl := make([]myCatalogPlacementView, 0, len(placements))
		folderHasVisible := map[uint64]bool{}
		for _, p := range placements {
			if !inScope(p.FolderID) {
				continue
			}
			if !all && !connectable[p.NodeID] {
				continue
			}
			visiblePl = append(visiblePl, myCatalogPlacementView{FolderID: p.FolderID, NodeID: p.NodeID, SortOrder: p.SortOrder})
			folderHasVisible[p.FolderID] = true
		}

		// Keep a folder iff it (or a descendant) holds a visible placement: for
		// each folder that directly holds one, mark its whole in-scope ancestor
		// chain (path segments) so intermediate folders survive the prune.
		keep := map[uint64]bool{}
		for _, f := range folders {
			if !folderHasVisible[f.ID] {
				continue
			}
			for _, seg := range strings.Split(f.Path, "/") {
				if seg == "" {
					continue
				}
				if fid, e := strconv.ParseUint(seg, 10, 64); e == nil && inScope(fid) {
					keep[fid] = true
				}
			}
		}

		fvs := make([]myCatalogFolderView, 0, len(folders))
		for _, f := range folders {
			if !keep[f.ID] {
				continue
			}
			fvs = append(fvs, myCatalogFolderView{ID: f.ID, ParentID: f.ParentID, Name: f.Name, Path: f.Path, Icon: f.Icon, SortOrder: f.SortOrder})
		}
		if len(fvs) == 0 && len(visiblePl) == 0 {
			continue
		}
		out = append(out, myCatalogView{ID: cat.ID, Name: cat.Name, Icon: cat.Icon, Description: cat.Description, Folders: fvs, Placements: visiblePl})
	}
	c.JSON(http.StatusOK, gin.H{"catalogs": out})
}
