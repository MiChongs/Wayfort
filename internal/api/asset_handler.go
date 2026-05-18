package api

import (
	"fmt"
	"net/http"
	"strconv"

	"github.com/gin-gonic/gin"
	"github.com/michongs/jumpserver-anonymous/internal/asset"
	"github.com/michongs/jumpserver-anonymous/internal/auth"
	"github.com/michongs/jumpserver-anonymous/internal/model"
	"github.com/michongs/jumpserver-anonymous/internal/repo"
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

// ----- Tags -----

type TagHandler struct {
	Repo     *repo.TagRepo
	Resolver *asset.Resolver
}

type tagPayload struct {
	Name  string `json:"name"`
	Color string `json:"color"`
}

func (h *TagHandler) List(c *gin.Context) {
	rows, err := h.Repo.List(c.Request.Context())
	if err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": err.Error()})
		return
	}
	c.JSON(http.StatusOK, gin.H{"tags": rows})
}

func (h *TagHandler) Create(c *gin.Context) {
	var p tagPayload
	if err := c.ShouldBindJSON(&p); err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"error": err.Error()})
		return
	}
	row := &model.AssetTag{Name: p.Name, Color: p.Color}
	if err := h.Repo.Create(c.Request.Context(), row); err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": err.Error()})
		return
	}
	c.JSON(http.StatusCreated, row)
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

func (h *GrantHandler) Delete(c *gin.Context) {
	id, _ := strconv.ParseUint(c.Param("id"), 10, 64)
	if err := h.Repo.Delete(c.Request.Context(), id); err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": err.Error()})
		return
	}
	h.Resolver.InvalidateAll(c.Request.Context())
	c.JSON(http.StatusOK, gin.H{"ok": true})
}
