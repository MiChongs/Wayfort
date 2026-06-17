package api

import (
	"net/http"
	"strconv"
	"time"

	"github.com/gin-gonic/gin"
	"github.com/michongs/wayfort/internal/auth"
	"github.com/michongs/wayfort/internal/model"
	"github.com/michongs/wayfort/internal/repo"
)

// UserHandler handles admin user management. /me/* lives in a separate handler.
// Sessions / History / Grants are read-only deps used to assemble the 360°
// detail view; they may be nil (detail just omits that section).
type UserHandler struct {
	Repo      *repo.UserRepo
	Roles     *repo.RoleRepo
	Depts     *repo.DepartmentRepo
	Lockout   *auth.LockoutPolicy
	Blocklist *auth.Blocklist
	Resolver  *auth.Resolver
	Sessions  *repo.SessionRepo
	History   *repo.LoginHistoryRepo
	Grants    *repo.GrantRepo
}

type userPayload struct {
	Username    string `json:"username"`
	Password    string `json:"password"`
	DisplayName string `json:"display_name"`
	Email       string `json:"email"`
	Phone       string `json:"phone"`
	// DepartmentIDs is the full multi-department set. DepartmentID is accepted
	// for back-compat: when DepartmentIDs is omitted we fall back to it.
	DepartmentIDs []uint64 `json:"department_ids"`
	DepartmentID  *uint64  `json:"department_id"`
	TagIDs        []uint64 `json:"tag_ids"`
	IsAdmin       bool     `json:"is_admin"`
	Disabled      bool     `json:"disabled"`
	MFAEnforced   bool     `json:"mfa_enforced"`
	PasskeyOnly   bool     `json:"passkey_only"`
	// Account lifecycle. Status defaults to active on create when omitted.
	// ExpiresAt nil means "never"; a zero/absent value clears any existing date.
	Status    string     `json:"status"`
	ExpiresAt *time.Time `json:"expires_at"`
	Note      string     `json:"note"`
}

func (p userPayload) effectiveDeptIDs() []uint64 {
	if p.DepartmentIDs != nil {
		return p.DepartmentIDs
	}
	if p.DepartmentID != nil {
		return []uint64{*p.DepartmentID}
	}
	return nil
}

func parseUintParam(s string) uint64 {
	id, _ := strconv.ParseUint(s, 10, 64)
	return id
}

func (h *UserHandler) List(c *gin.Context) {
	f := repo.UserFilter{
		Search: c.Query("search"),
		Status: c.Query("status"),
		Sort:   c.Query("sort"),
		Desc:   c.Query("order") == "desc",
	}
	if s := c.Query("disabled"); s != "" {
		v := s == "true"
		f.Disabled = &v
	}
	if s := c.Query("mfa"); s != "" {
		v := s == "true"
		f.MFAEnforced = &v
	}
	if id := parseUintParam(c.Query("department_id")); id != 0 {
		f.DepartmentID = &id
	}
	if id := parseUintParam(c.Query("role_id")); id != 0 {
		f.RoleID = &id
	}
	if id := parseUintParam(c.Query("tag_id")); id != 0 {
		f.TagID = &id
	}
	if d := c.Query("active_days"); d != "" {
		if n, err := strconv.Atoi(d); err == nil && n > 0 {
			t := time.Now().AddDate(0, 0, -n)
			f.ActiveSince = &t
		}
	}
	f.Limit, _ = strconv.Atoi(c.DefaultQuery("limit", "50"))
	f.Offset, _ = strconv.Atoi(c.DefaultQuery("offset", "0"))

	rows, total, err := h.Repo.List(c.Request.Context(), f)
	if err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": err.Error()})
		return
	}
	h.attachAssociations(c, rows)
	c.JSON(http.StatusOK, gin.H{"users": rows, "total": total})
}

// attachAssociations batch-loads each row's department set and tag set so the
// list/detail responses carry them without an N+1 query per user.
func (h *UserHandler) attachAssociations(c *gin.Context, rows []model.User) {
	if len(rows) == 0 {
		return
	}
	ids := make([]uint64, len(rows))
	for i := range rows {
		ids[i] = rows[i].ID
	}
	if h.Depts != nil {
		if byUser, err := h.Depts.DepartmentsForUsers(c.Request.Context(), ids); err == nil {
			for i := range rows {
				rows[i].DepartmentIDs = byUser[rows[i].ID]
			}
		}
	}
	if byUser, err := h.Repo.TagsForUsers(c.Request.Context(), ids); err == nil {
		for i := range rows {
			rows[i].TagIDs = byUser[rows[i].ID]
		}
	}
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
	status := p.Status
	if status == "" {
		status = model.UserStatusActive
	}
	deptIDs := p.effectiveDeptIDs()
	user := &model.User{
		Username:     p.Username,
		PasswordHash: hash,
		DisplayName:  p.DisplayName,
		Email:        p.Email,
		Phone:        p.Phone,
		IsAdmin:      p.IsAdmin,
		Disabled:     p.Disabled,
		MFAEnforced:  p.MFAEnforced,
		PasskeyOnly:  p.PasskeyOnly,
		Status:       status,
		ExpiresAt:    p.ExpiresAt,
		Note:         p.Note,
	}
	if len(deptIDs) > 0 {
		user.DepartmentID = &deptIDs[0]
	}
	if err := h.Repo.Create(c.Request.Context(), user); err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": err.Error()})
		return
	}
	if h.Depts != nil {
		_ = h.Depts.SetUserDepartments(c.Request.Context(), user.ID, deptIDs)
	}
	if p.TagIDs != nil {
		_ = h.Repo.SetUserTags(c.Request.Context(), user.ID, p.TagIDs)
	}
	user.DepartmentIDs = deptIDs
	user.TagIDs = p.TagIDs
	c.JSON(http.StatusCreated, user)
}

func (h *UserHandler) Update(c *gin.Context) {
	id := parseUintParam(c.Param("id"))
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
	// Assign directly (no "if != \"\"" guards) so a field CAN be cleared — the
	// old code made it impossible to blank a display name or note.
	user.DisplayName = p.DisplayName
	user.Email = p.Email
	user.Phone = p.Phone
	user.IsAdmin = p.IsAdmin
	user.Disabled = p.Disabled
	user.MFAEnforced = p.MFAEnforced
	user.PasskeyOnly = p.PasskeyOnly
	user.Note = p.Note
	user.ExpiresAt = p.ExpiresAt
	if p.Status != "" {
		user.Status = p.Status
	}
	deptIDs := p.effectiveDeptIDs()
	if len(deptIDs) > 0 {
		user.DepartmentID = &deptIDs[0]
	} else {
		user.DepartmentID = nil
	}
	if err := h.Repo.Update(c.Request.Context(), user); err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": err.Error()})
		return
	}
	if h.Depts != nil {
		_ = h.Depts.SetUserDepartments(c.Request.Context(), id, deptIDs)
	}
	if p.TagIDs != nil {
		_ = h.Repo.SetUserTags(c.Request.Context(), id, p.TagIDs)
	}
	user.DepartmentIDs = deptIDs
	user.TagIDs = p.TagIDs
	h.Resolver.Invalidate(c.Request.Context(), id)
	c.JSON(http.StatusOK, user)
}

func (h *UserHandler) Delete(c *gin.Context) {
	id := parseUintParam(c.Param("id"))
	if err := h.Repo.Delete(c.Request.Context(), id); err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": err.Error()})
		return
	}
	c.JSON(http.StatusOK, gin.H{"ok": true})
}

func (h *UserHandler) ResetPassword(c *gin.Context) {
	id := parseUintParam(c.Param("id"))
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
	id := parseUintParam(c.Param("id"))
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
	id := parseUintParam(c.Param("id"))
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
	id := parseUintParam(c.Param("id"))
	roles, err := h.Roles.RolesForUser(c.Request.Context(), id)
	if err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": err.Error()})
		return
	}
	c.JSON(http.StatusOK, gin.H{"roles": roles})
}

func (h *UserHandler) ReplaceRoles(c *gin.Context) {
	id := parseUintParam(c.Param("id"))
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

// Stats powers the admin overview strip + new-user trend sparkline.
func (h *UserHandler) Stats(c *gin.Context) {
	days, _ := strconv.Atoi(c.DefaultQuery("days", "14"))
	stats, err := h.Repo.Stats(c.Request.Context(), days)
	if err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": err.Error()})
		return
	}
	c.JSON(http.StatusOK, stats)
}

// SetTags replaces a user's managed-tag set.
func (h *UserHandler) SetTags(c *gin.Context) {
	id := parseUintParam(c.Param("id"))
	var body struct {
		TagIDs []uint64 `json:"tag_ids"`
	}
	if err := c.ShouldBindJSON(&body); err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"error": err.Error()})
		return
	}
	if err := h.Repo.SetUserTags(c.Request.Context(), id, body.TagIDs); err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": err.Error()})
		return
	}
	c.JSON(http.StatusOK, gin.H{"ok": true})
}

// Detail assembles the 360° view: the user (with departments + tags), their
// roles, recent + total sessions, recent login history, and the grants pinned
// directly to them. Each section degrades gracefully if its dep is nil.
func (h *UserHandler) Detail(c *gin.Context) {
	id := parseUintParam(c.Param("id"))
	user, err := h.Repo.FindByID(c.Request.Context(), id)
	if err != nil || user == nil {
		c.JSON(http.StatusNotFound, gin.H{"error": "not found"})
		return
	}
	if h.Depts != nil {
		if byUser, e := h.Depts.DepartmentsForUsers(c.Request.Context(), []uint64{id}); e == nil {
			user.DepartmentIDs = byUser[id]
		}
	}
	if byUser, e := h.Repo.TagsForUsers(c.Request.Context(), []uint64{id}); e == nil {
		user.TagIDs = byUser[id]
	}

	roles, _ := h.Roles.RolesForUser(c.Request.Context(), id)

	var sessions []model.Session
	var sessionTotal int64
	if h.Sessions != nil {
		sessions, _ = h.Sessions.List(c.Request.Context(), repo.ListSessionFilter{UserID: &id, Limit: 6})
		sessionTotal, _ = h.Sessions.Count(c.Request.Context(), repo.ListSessionFilter{UserID: &id})
	}

	var history []model.LoginHistory
	if h.History != nil {
		history, _ = h.History.ListByUser(c.Request.Context(), id, 8)
	}

	var grants []model.AssetGrant
	if h.Grants != nil {
		grants, _ = h.Grants.ListForGrantees(c.Request.Context(),
			[]model.GranteeType{model.GranteeUser}, []uint64{id})
	}

	c.JSON(http.StatusOK, gin.H{
		"user":          user,
		"roles":         roles,
		"sessions":      sessions,
		"session_total": sessionTotal,
		"login_history": history,
		"grants":        grants,
	})
}

// Bulk applies one action to many users in a single call. Department changes go
// through the department repo (join table); status/enable/disable patch the
// users table; force-logout revokes tokens; delete cascades per-user.
func (h *UserHandler) Bulk(c *gin.Context) {
	var body struct {
		IDs           []uint64 `json:"ids"`
		Action        string   `json:"action"`
		DepartmentIDs []uint64 `json:"department_ids"`
	}
	if err := c.ShouldBindJSON(&body); err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"error": err.Error()})
		return
	}
	if len(body.IDs) == 0 {
		c.JSON(http.StatusBadRequest, gin.H{"error": "no users selected"})
		return
	}
	ctx := c.Request.Context()
	var affected int64
	var err error
	switch body.Action {
	case "enable":
		affected, err = h.Repo.BulkUpdate(ctx, body.IDs, map[string]any{"disabled": false})
	case "disable":
		affected, err = h.Repo.BulkUpdate(ctx, body.IDs, map[string]any{"disabled": true})
	case "activate":
		affected, err = h.Repo.BulkUpdate(ctx, body.IDs, map[string]any{"status": model.UserStatusActive, "disabled": false})
	case "suspend":
		affected, err = h.Repo.BulkUpdate(ctx, body.IDs, map[string]any{"status": model.UserStatusSuspended})
	case "depart":
		affected, err = h.Repo.BulkUpdate(ctx, body.IDs, map[string]any{"status": model.UserStatusDeparted})
	case "set-department":
		if h.Depts != nil {
			for _, id := range body.IDs {
				_ = h.Depts.SetUserDepartments(ctx, id, body.DepartmentIDs)
			}
			affected = int64(len(body.IDs))
		}
	case "force-logout":
		if h.Blocklist != nil {
			for _, id := range body.IDs {
				_ = h.Blocklist.RevokeAll(ctx, id, 7*24*60*60*1_000_000_000)
			}
			affected = int64(len(body.IDs))
		}
	case "delete":
		err = h.Repo.BulkDelete(ctx, body.IDs)
		affected = int64(len(body.IDs))
	default:
		c.JSON(http.StatusBadRequest, gin.H{"error": "unknown action: " + body.Action})
		return
	}
	if err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": err.Error()})
		return
	}
	// Anything touching auth state invalidates the per-user RBAC cache.
	for _, id := range body.IDs {
		h.Resolver.Invalidate(ctx, id)
	}
	c.JSON(http.StatusOK, gin.H{"ok": true, "affected": affected})
}
