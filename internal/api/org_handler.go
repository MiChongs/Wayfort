package api

import (
	"fmt"
	"net/http"
	"strconv"

	"github.com/gin-gonic/gin"
	"github.com/michongs/jumpserver-anonymous/internal/model"
	"github.com/michongs/jumpserver-anonymous/internal/repo"
)

// ----- Department -----

type DepartmentHandler struct{ Repo *repo.DepartmentRepo }

type deptPayload struct {
	Name     string  `json:"name"`
	ParentID *uint64 `json:"parent_id"`
	OrderIdx int     `json:"order_idx"`
}

func (h *DepartmentHandler) List(c *gin.Context) {
	rows, err := h.Repo.List(c.Request.Context())
	if err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": err.Error()})
		return
	}
	c.JSON(http.StatusOK, gin.H{"departments": rows})
}

func (h *DepartmentHandler) Tree(c *gin.Context) {
	rows, err := h.Repo.List(c.Request.Context())
	if err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": err.Error()})
		return
	}
	c.JSON(http.StatusOK, gin.H{"departments": rows}) // path-ordered already
}

func (h *DepartmentHandler) Create(c *gin.Context) {
	var p deptPayload
	if err := c.ShouldBindJSON(&p); err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"error": err.Error()})
		return
	}
	row := &model.Department{Name: p.Name, ParentID: p.ParentID, OrderIdx: p.OrderIdx}
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
	row.OrderIdx = p.OrderIdx
	if err := h.Repo.Update(c.Request.Context(), row); err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": err.Error()})
		return
	}
	c.JSON(http.StatusOK, row)
}

func (h *DepartmentHandler) Delete(c *gin.Context) {
	id, _ := strconv.ParseUint(c.Param("id"), 10, 64)
	if err := h.Repo.Delete(c.Request.Context(), id); err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": err.Error()})
		return
	}
	c.JSON(http.StatusOK, gin.H{"ok": true})
}

// ----- UserGroup -----

type GroupHandler struct{ Repo *repo.UserGroupRepo }

type groupPayload struct {
	Name        string `json:"name"`
	Description string `json:"description"`
}

func (h *GroupHandler) List(c *gin.Context) {
	rows, err := h.Repo.List(c.Request.Context())
	if err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": err.Error()})
		return
	}
	c.JSON(http.StatusOK, gin.H{"groups": rows})
}

func (h *GroupHandler) Create(c *gin.Context) {
	var p groupPayload
	if err := c.ShouldBindJSON(&p); err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"error": err.Error()})
		return
	}
	row := &model.UserGroup{Name: p.Name, Description: p.Description}
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
	if err := h.Repo.Update(c.Request.Context(), row); err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": err.Error()})
		return
	}
	c.JSON(http.StatusOK, row)
}

func (h *GroupHandler) Delete(c *gin.Context) {
	id, _ := strconv.ParseUint(c.Param("id"), 10, 64)
	if err := h.Repo.Delete(c.Request.Context(), id); err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": err.Error()})
		return
	}
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
	c.JSON(http.StatusOK, gin.H{"ok": true})
}

func (h *GroupHandler) RemoveMember(c *gin.Context) {
	gid, _ := strconv.ParseUint(c.Param("id"), 10, 64)
	uid, _ := strconv.ParseUint(c.Param("uid"), 10, 64)
	if err := h.Repo.RemoveMember(c.Request.Context(), gid, uid); err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": err.Error()})
		return
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
