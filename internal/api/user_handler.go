package api

import (
	"net/http"
	"strconv"

	"github.com/gin-gonic/gin"
	"github.com/michongs/jumpserver-anonymous/internal/auth"
	"github.com/michongs/jumpserver-anonymous/internal/model"
	"github.com/michongs/jumpserver-anonymous/internal/repo"
)

// UserHandler handles admin user management. /me/* lives in a separate handler.
type UserHandler struct {
	Repo      *repo.UserRepo
	Roles     *repo.RoleRepo
	Lockout   *auth.LockoutPolicy
	Blocklist *auth.Blocklist
	Resolver  *auth.Resolver
}

type userPayload struct {
	Username     string  `json:"username"`
	Password     string  `json:"password"`
	DisplayName  string  `json:"display_name"`
	Email        string  `json:"email"`
	Phone        string  `json:"phone"`
	DepartmentID *uint64 `json:"department_id"`
	IsAdmin      bool    `json:"is_admin"`
	Disabled     bool    `json:"disabled"`
	MFAEnforced  bool    `json:"mfa_enforced"`
	PasskeyOnly  bool    `json:"passkey_only"`
}

func (h *UserHandler) List(c *gin.Context) {
	var disabled *bool
	if s := c.Query("disabled"); s != "" {
		v := s == "true"
		disabled = &v
	}
	var deptID *uint64
	if s := c.Query("department_id"); s != "" {
		if id, err := strconv.ParseUint(s, 10, 64); err == nil {
			deptID = &id
		}
	}
	limit, _ := strconv.Atoi(c.DefaultQuery("limit", "100"))
	offset, _ := strconv.Atoi(c.DefaultQuery("offset", "0"))
	rows, err := h.Repo.List(c.Request.Context(), repo.UserFilter{
		Search: c.Query("search"), DepartmentID: deptID, Disabled: disabled,
		Limit: limit, Offset: offset,
	})
	if err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": err.Error()})
		return
	}
	c.JSON(http.StatusOK, gin.H{"users": rows})
}

func (h *UserHandler) Create(c *gin.Context) {
	var p userPayload
	if err := c.ShouldBindJSON(&p); err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"error": err.Error()})
		return
	}
	if p.Username == "" || p.Password == "" {
		c.JSON(http.StatusBadRequest, gin.H{"error": "username and password required"})
		return
	}
	hash, err := auth.HashPassword(p.Password)
	if err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": err.Error()})
		return
	}
	user := &model.User{
		Username:     p.Username,
		PasswordHash: hash,
		DisplayName:  p.DisplayName,
		Email:        p.Email,
		Phone:        p.Phone,
		DepartmentID: p.DepartmentID,
		IsAdmin:      p.IsAdmin,
		Disabled:     p.Disabled,
		MFAEnforced:  p.MFAEnforced,
		PasskeyOnly:  p.PasskeyOnly,
	}
	if err := h.Repo.Create(c.Request.Context(), user); err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": err.Error()})
		return
	}
	c.JSON(http.StatusCreated, user)
}

func (h *UserHandler) Update(c *gin.Context) {
	id, _ := strconv.ParseUint(c.Param("id"), 10, 64)
	user, err := h.Repo.FindByID(c.Request.Context(), id)
	if err != nil || user == nil {
		c.JSON(http.StatusNotFound, gin.H{"error": "not found"})
		return
	}
	var p userPayload
	if err := c.ShouldBindJSON(&p); err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"error": err.Error()})
		return
	}
	if p.DisplayName != "" {
		user.DisplayName = p.DisplayName
	}
	if p.Email != "" {
		user.Email = p.Email
	}
	user.Phone = p.Phone
	user.DepartmentID = p.DepartmentID
	user.IsAdmin = p.IsAdmin
	user.Disabled = p.Disabled
	user.MFAEnforced = p.MFAEnforced
	user.PasskeyOnly = p.PasskeyOnly
	if err := h.Repo.Update(c.Request.Context(), user); err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": err.Error()})
		return
	}
	h.Resolver.Invalidate(c.Request.Context(), id)
	c.JSON(http.StatusOK, user)
}

func (h *UserHandler) Delete(c *gin.Context) {
	id, _ := strconv.ParseUint(c.Param("id"), 10, 64)
	if err := h.Repo.Delete(c.Request.Context(), id); err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": err.Error()})
		return
	}
	c.JSON(http.StatusOK, gin.H{"ok": true})
}

func (h *UserHandler) ResetPassword(c *gin.Context) {
	id, _ := strconv.ParseUint(c.Param("id"), 10, 64)
	var body struct {
		Password string `json:"password" binding:"required"`
	}
	if err := c.ShouldBindJSON(&body); err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"error": err.Error()})
		return
	}
	hash, err := auth.HashPassword(body.Password)
	if err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": err.Error()})
		return
	}
	if err := h.Repo.UpdatePassword(c.Request.Context(), id, hash); err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": err.Error()})
		return
	}
	c.JSON(http.StatusOK, gin.H{"ok": true})
}

func (h *UserHandler) Unlock(c *gin.Context) {
	id, _ := strconv.ParseUint(c.Param("id"), 10, 64)
	user, err := h.Repo.FindByID(c.Request.Context(), id)
	if err != nil || user == nil {
		c.JSON(http.StatusNotFound, gin.H{"error": "not found"})
		return
	}
	_ = h.Repo.SetLockedUntil(c.Request.Context(), id, nil)
	_ = h.Lockout.Unlock(c.Request.Context(), user.Username)
	c.JSON(http.StatusOK, gin.H{"ok": true})
}

func (h *UserHandler) ForceLogout(c *gin.Context) {
	id, _ := strconv.ParseUint(c.Param("id"), 10, 64)
	if h.Blocklist == nil {
		c.JSON(http.StatusServiceUnavailable, gin.H{"error": "blocklist unavailable"})
		return
	}
	if err := h.Blocklist.RevokeAll(c.Request.Context(), id, 7*24*60*60*1_000_000_000); err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": err.Error()})
		return
	}
	c.JSON(http.StatusOK, gin.H{"ok": true})
}

func (h *UserHandler) ListRoles(c *gin.Context) {
	id, _ := strconv.ParseUint(c.Param("id"), 10, 64)
	roles, err := h.Roles.RolesForUser(c.Request.Context(), id)
	if err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": err.Error()})
		return
	}
	c.JSON(http.StatusOK, gin.H{"roles": roles})
}

func (h *UserHandler) ReplaceRoles(c *gin.Context) {
	id, _ := strconv.ParseUint(c.Param("id"), 10, 64)
	var body struct {
		RoleIDs []uint64 `json:"role_ids"`
	}
	if err := c.ShouldBindJSON(&body); err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"error": err.Error()})
		return
	}
	claims := auth.FromContext(c.Request.Context())
	var grantedBy *uint64
	if claims != nil {
		uid := claims.UserID
		grantedBy = &uid
	}
	if err := h.Roles.ReplaceUserRoles(c.Request.Context(), id, body.RoleIDs, grantedBy); err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": err.Error()})
		return
	}
	h.Resolver.Invalidate(c.Request.Context(), id)
	c.JSON(http.StatusOK, gin.H{"ok": true})
}
