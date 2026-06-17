package api

import (
	"net/http"
	"strconv"

	"github.com/gin-gonic/gin"
	"github.com/michongs/wayfort/internal/auth"
	"github.com/michongs/wayfort/internal/model"
	"github.com/michongs/wayfort/internal/repo"
)

type RoleHandler struct {
	Repo     *repo.RoleRepo
	Resolver *auth.Resolver
}

type rolePayload struct {
	Name        string   `json:"name"`
	Description string   `json:"description"`
	Permissions []string `json:"permissions"`
}

func (h *RoleHandler) List(c *gin.Context) {
	roles, err := h.Repo.List(c.Request.Context())
	if err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": err.Error()})
		return
	}
	out := make([]gin.H, 0, len(roles))
	for _, r := range roles {
		perms, _ := h.Repo.PermissionsFor(c.Request.Context(), r.ID)
		out = append(out, gin.H{
			"id":          r.ID,
			"name":        r.Name,
			"description": r.Description,
			"is_system":   r.IsSystem,
			"permissions": perms,
		})
	}
	c.JSON(http.StatusOK, gin.H{"roles": out})
}

func (h *RoleHandler) Create(c *gin.Context) {
	var p rolePayload
	if err := c.ShouldBindJSON(&p); err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"error": err.Error()})
		return
	}
	if p.Name == "" {
		c.JSON(http.StatusBadRequest, gin.H{"error": "name required"})
		return
	}
	role := &model.Role{Name: p.Name, Description: p.Description}
	if err := h.Repo.Create(c.Request.Context(), role); err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": err.Error()})
		return
	}
	if err := h.Repo.SetPermissions(c.Request.Context(), role.ID, p.Permissions); err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": err.Error()})
		return
	}
	c.JSON(http.StatusCreated, role)
}

func (h *RoleHandler) Update(c *gin.Context) {
	id, _ := strconv.ParseUint(c.Param("id"), 10, 64)
	role, err := h.Repo.FindByID(c.Request.Context(), id)
	if err != nil || role == nil {
		c.JSON(http.StatusNotFound, gin.H{"error": "not found"})
		return
	}
	var p rolePayload
	if err := c.ShouldBindJSON(&p); err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"error": err.Error()})
		return
	}
	if p.Name != "" {
		role.Name = p.Name
	}
	role.Description = p.Description
	if err := h.Repo.Update(c.Request.Context(), role); err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": err.Error()})
		return
	}
	if p.Permissions != nil {
		if err := h.Repo.SetPermissions(c.Request.Context(), id, p.Permissions); err != nil {
			c.JSON(http.StatusInternalServerError, gin.H{"error": err.Error()})
			return
		}
	}
	c.JSON(http.StatusOK, role)
}

func (h *RoleHandler) Delete(c *gin.Context) {
	id, _ := strconv.ParseUint(c.Param("id"), 10, 64)
	if err := h.Repo.Delete(c.Request.Context(), id); err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"error": err.Error()})
		return
	}
	c.JSON(http.StatusOK, gin.H{"ok": true})
}

func (h *RoleHandler) Permissions(c *gin.Context) {
	rows, err := h.Repo.ListPermissions(c.Request.Context())
	if err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": err.Error()})
		return
	}
	c.JSON(http.StatusOK, gin.H{"permissions": rows})
}
