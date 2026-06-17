package api

import (
	"net/http"
	"strconv"

	"github.com/gin-gonic/gin"
	"github.com/michongs/wayfort/internal/asset"
	"github.com/michongs/wayfort/internal/model"
	"github.com/michongs/wayfort/internal/repo"
)

// ----- Department -----

type DepartmentHandler struct {
	Repo     *repo.DepartmentRepo
	Resolver *asset.Resolver
}

type deptPayload struct {
	Name        string  `json:"name"`
	Description string  `json:"description"`
	Icon        string  `json:"icon"`
	ParentID    *uint64 `json:"parent_id"`
	OrderIdx    int     `json:"order_idx"`
}

func (h *DepartmentHandler) List(c *gin.Context) {
	rows, err := h.Repo.List(c.Request.Context())
	if err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": err.Error()})
		return
	}
	members, err := h.Repo.MembershipsByDept(c.Request.Context())
	if err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": err.Error()})
		return
	}
	for i := range rows {
		rows[i].MemberIDs = members[rows[i].ID]
	}
	c.JSON(http.StatusOK, gin.H{"departments": rows})
}

// Tree is kept as an alias of List (rows are path-ordered, so the frontend can
// build the forest directly).
func (h *DepartmentHandler) Tree(c *gin.Context) { h.List(c) }

func (h *DepartmentHandler) Create(c *gin.Context) {
	var p deptPayload
	if err := c.ShouldBindJSON(&p); err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"error": err.Error()})
		return
	}
	if p.Name == "" {
		c.JSON(http.StatusBadRequest, gin.H{"error": "名称不能为空"})
		return
	}
	row := &model.Department{Name: p.Name, Description: p.Description, Icon: p.Icon, ParentID: p.ParentID, OrderIdx: p.OrderIdx}
	if err := h.Repo.Create(c.Request.Context(), row); err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": err.Error()})
		return
	}
	c.JSON(http.StatusCreated, row)
}

func (h *DepartmentHandler) Update(c *gin.Context) {
	id, _ := strconv.ParseUint(c.Param("id"), 10, 64)
	row, err := h.Repo.FindByID(c.Request.Context(), id)
	if err != nil || row == nil {
		c.JSON(http.StatusNotFound, gin.H{"error": "not found"})
		return
	}
	var p deptPayload
	if err := c.ShouldBindJSON(&p); err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"error": err.Error()})
		return
	}
	if p.Name != "" {
		row.Name = p.Name
	}
	row.Description = p.Description
	row.Icon = p.Icon
	row.OrderIdx = p.OrderIdx
	if err := h.Repo.Update(c.Request.Context(), row); err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": err.Error()})
		return
	}
	c.JSON(http.StatusOK, row)
}

func (h *DepartmentHandler) Move(c *gin.Context) {
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
	h.invalidate(c)
	row, _ := h.Repo.FindByID(c.Request.Context(), id)
	c.JSON(http.StatusOK, row)
}

func (h *DepartmentHandler) Delete(c *gin.Context) {
	id, _ := strconv.ParseUint(c.Param("id"), 10, 64)
	if err := h.Repo.Delete(c.Request.Context(), id); err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": err.Error()})
		return
	}
	h.invalidate(c)
	c.JSON(http.StatusOK, gin.H{"ok": true})
}

func (h *DepartmentHandler) Members(c *gin.Context) {
	id, _ := strconv.ParseUint(c.Param("id"), 10, 64)
	uids, err := h.Repo.MembersOf(c.Request.Context(), id)
	if err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": err.Error()})
		return
	}
	c.JSON(http.StatusOK, gin.H{"user_ids": uids})
}

func (h *DepartmentHandler) AddMember(c *gin.Context) {
	id, _ := strconv.ParseUint(c.Param("id"), 10, 64)
	var body struct {
		UserID uint64 `json:"user_id"`
	}
	if err := c.ShouldBindJSON(&body); err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"error": err.Error()})
		return
	}
	if err := h.Repo.AddMember(c.Request.Context(), id, body.UserID); err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": err.Error()})
		return
	}
	if h.Resolver != nil {
		h.Resolver.Invalidate(c.Request.Context(), body.UserID)
	}
	c.JSON(http.StatusOK, gin.H{"ok": true})
}

func (h *DepartmentHandler) RemoveMember(c *gin.Context) {
	id, _ := strconv.ParseUint(c.Param("id"), 10, 64)
	uid, _ := strconv.ParseUint(c.Param("uid"), 10, 64)
	if err := h.Repo.RemoveMember(c.Request.Context(), id, uid); err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": err.Error()})
		return
	}
	if h.Resolver != nil {
		h.Resolver.Invalidate(c.Request.Context(), uid)
	}
	c.JSON(http.StatusOK, gin.H{"ok": true})
}

func (h *DepartmentHandler) invalidate(c *gin.Context) {
	if h.Resolver != nil {
		h.Resolver.InvalidateAll(c.Request.Context())
	}
}

// ----- UserGroup -----

type GroupHandler struct {
	Repo     *repo.UserGroupRepo
	Resolver *asset.Resolver
}

type groupPayload struct {
	Name        string  `json:"name"`
	Description string  `json:"description"`
	Icon        string  `json:"icon"`
	ParentID    *uint64 `json:"parent_id"`
	OrderIdx    int     `json:"order_idx"`
}

func (h *GroupHandler) List(c *gin.Context) {
	rows, err := h.Repo.List(c.Request.Context())
	if err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": err.Error()})
		return
	}
	members, err := h.Repo.MembershipsByGroup(c.Request.Context())
	if err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": err.Error()})
		return
	}
	for i := range rows {
		rows[i].MemberIDs = members[rows[i].ID]
	}
	c.JSON(http.StatusOK, gin.H{"groups": rows})
}

func (h *GroupHandler) Create(c *gin.Context) {
	var p groupPayload
	if err := c.ShouldBindJSON(&p); err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"error": err.Error()})
		return
	}
	if p.Name == "" {
		c.JSON(http.StatusBadRequest, gin.H{"error": "名称不能为空"})
		return
	}
	row := &model.UserGroup{Name: p.Name, Description: p.Description, Icon: p.Icon, ParentID: p.ParentID, OrderIdx: p.OrderIdx}
	if err := h.Repo.Create(c.Request.Context(), row); err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": err.Error()})
		return
	}
	c.JSON(http.StatusCreated, row)
}

func (h *GroupHandler) Update(c *gin.Context) {
	id, _ := strconv.ParseUint(c.Param("id"), 10, 64)
	row, err := h.Repo.FindByID(c.Request.Context(), id)
	if err != nil || row == nil {
		c.JSON(http.StatusNotFound, gin.H{"error": "not found"})
		return
	}
	var p groupPayload
	if err := c.ShouldBindJSON(&p); err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"error": err.Error()})
		return
	}
	if p.Name != "" {
		row.Name = p.Name
	}
	row.Description = p.Description
	row.Icon = p.Icon
	row.OrderIdx = p.OrderIdx
	if err := h.Repo.Update(c.Request.Context(), row); err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": err.Error()})
		return
	}
	c.JSON(http.StatusOK, row)
}

func (h *GroupHandler) Move(c *gin.Context) {
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
	h.invalidate(c)
	row, _ := h.Repo.FindByID(c.Request.Context(), id)
	c.JSON(http.StatusOK, row)
}

func (h *GroupHandler) Delete(c *gin.Context) {
	id, _ := strconv.ParseUint(c.Param("id"), 10, 64)
	if err := h.Repo.Delete(c.Request.Context(), id); err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": err.Error()})
		return
	}
	h.invalidate(c)
	c.JSON(http.StatusOK, gin.H{"ok": true})
}

func (h *GroupHandler) AddMember(c *gin.Context) {
	gid, _ := strconv.ParseUint(c.Param("id"), 10, 64)
	var body struct {
		UserID uint64 `json:"user_id"`
	}
	if err := c.ShouldBindJSON(&body); err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"error": err.Error()})
		return
	}
	if err := h.Repo.AddMember(c.Request.Context(), gid, body.UserID); err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": err.Error()})
		return
	}
	if h.Resolver != nil {
		h.Resolver.Invalidate(c.Request.Context(), body.UserID)
	}
	c.JSON(http.StatusOK, gin.H{"ok": true})
}

func (h *GroupHandler) RemoveMember(c *gin.Context) {
	gid, _ := strconv.ParseUint(c.Param("id"), 10, 64)
	uid, _ := strconv.ParseUint(c.Param("uid"), 10, 64)
	if err := h.Repo.RemoveMember(c.Request.Context(), gid, uid); err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": err.Error()})
		return
	}
	if h.Resolver != nil {
		h.Resolver.Invalidate(c.Request.Context(), uid)
	}
	c.JSON(http.StatusOK, gin.H{"ok": true})
}

func (h *GroupHandler) Members(c *gin.Context) {
	gid, _ := strconv.ParseUint(c.Param("id"), 10, 64)
	uids, err := h.Repo.MembersOfGroup(c.Request.Context(), gid)
	if err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": err.Error()})
		return
	}
	c.JSON(http.StatusOK, gin.H{"user_ids": uids})
}

func (h *GroupHandler) invalidate(c *gin.Context) {
	if h.Resolver != nil {
		h.Resolver.InvalidateAll(c.Request.Context())
	}
}
