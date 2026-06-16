package api

import (
	"errors"
	"net/http"
	"strconv"
	"strings"
	"time"

	"github.com/gin-gonic/gin"
	"github.com/michongs/jumpserver-anonymous/internal/auth"
	"github.com/michongs/jumpserver-anonymous/internal/breakglass"
	"github.com/michongs/jumpserver-anonymous/internal/model"
	"github.com/michongs/jumpserver-anonymous/internal/repo"
)

// BreakGlassHandler exposes the emergency-access (应急访问) surface. The Svc is
// nil when the subsystem is unwired; every handler degrades to 503 in that case
// (the same stub semantics as the other optional features).
type BreakGlassHandler struct {
	Svc *breakglass.Service
}

func NewBreakGlassHandler(svc *breakglass.Service) *BreakGlassHandler {
	return &BreakGlassHandler{Svc: svc}
}

func (h *BreakGlassHandler) ready(c *gin.Context) bool {
	if h == nil || h.Svc == nil {
		c.AbortWithStatusJSON(http.StatusServiceUnavailable,
			gin.H{"error": "break-glass subsystem not initialised on this gateway"})
		return false
	}
	return true
}

// ----- Activation (self-service) -----

type activateBreakGlassReq struct {
	NodeID        uint64 `json:"node_id"`
	PolicyID      uint64 `json:"policy_id,omitempty"`
	Justification string `json:"justification"`
	IncidentRef   string `json:"incident_ref,omitempty"`
	Mode          string `json:"mode,omitempty"` // "fail_open" | "pre_approved" (default)
	DurationSec   int    `json:"duration_sec,omitempty"`
}

// Activate breaks the glass on a node. Any authenticated user may request
// emergency access for themselves — policy + global gates decide what actually
// happens (immediate fail-open vs. an expedited approval request).
func (h *BreakGlassHandler) Activate(c *gin.Context) {
	if !h.ready(c) {
		return
	}
	claims := auth.FromContext(c.Request.Context())
	if claims == nil || claims.Anonymous {
		c.AbortWithStatusJSON(http.StatusForbidden, gin.H{"error": "not allowed"})
		return
	}
	var req activateBreakGlassReq
	if err := c.ShouldBindJSON(&req); err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"error": "invalid request: " + err.Error()})
		return
	}
	if req.NodeID == 0 {
		c.JSON(http.StatusBadRequest, gin.H{"error": "node_id is required"})
		return
	}
	mode := model.BreakGlassModePreApproved
	if strings.EqualFold(req.Mode, string(model.BreakGlassModeFailOpen)) {
		mode = model.BreakGlassModeFailOpen
	}
	act, err := h.Svc.Activate(c.Request.Context(), breakglass.ActivateInput{
		NodeID:        req.NodeID,
		PolicyID:      req.PolicyID,
		Justification: req.Justification,
		IncidentRef:   req.IncidentRef,
		Mode:          mode,
		DurationSec:   req.DurationSec,
		RequesterID:   claims.UserID,
		RequesterName: claims.Username,
		ClientIP:      c.ClientIP(),
	})
	if err != nil {
		h.activateError(c, err)
		return
	}
	c.JSON(http.StatusOK, gin.H{"activation": act})
}

func (h *BreakGlassHandler) activateError(c *gin.Context, err error) {
	switch {
	case errors.Is(err, breakglass.ErrDisabled):
		c.JSON(http.StatusServiceUnavailable, gin.H{"error": "应急访问当前未启用", "code": "break_glass_disabled"})
	case errors.Is(err, breakglass.ErrNoPolicy):
		c.JSON(http.StatusForbidden, gin.H{"error": "没有适用于该资产的应急访问策略", "code": "no_break_glass_policy"})
	case errors.Is(err, breakglass.ErrAuditRefused):
		c.JSON(http.StatusServiceUnavailable, gin.H{"error": err.Error(), "code": "audit_unavailable"})
	default:
		c.JSON(http.StatusBadRequest, gin.H{"error": err.Error()})
	}
}

// ListMine returns the caller's own activations.
func (h *BreakGlassHandler) ListMine(c *gin.Context) {
	if !h.ready(c) {
		return
	}
	claims := auth.FromContext(c.Request.Context())
	if claims == nil {
		c.AbortWithStatusJSON(http.StatusForbidden, gin.H{"error": "not allowed"})
		return
	}
	limit, _ := strconv.Atoi(c.DefaultQuery("limit", "50"))
	offset, _ := strconv.Atoi(c.DefaultQuery("offset", "0"))
	rows, total, err := h.Svc.List(c.Request.Context(), repo.BreakGlassFilter{
		RequesterID: claims.UserID,
		Status:      c.Query("status"),
		Limit:       limit,
		Offset:      offset,
	})
	if err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": err.Error()})
		return
	}
	c.JSON(http.StatusOK, gin.H{"activations": rows, "total": total})
}

// Get returns one activation. The requester may always read their own; everyone
// else needs the governance permission (enforced here so the route can stay on
// the authenticated group for the self-service case).
func (h *BreakGlassHandler) Get(c *gin.Context) {
	if !h.ready(c) {
		return
	}
	claims := auth.FromContext(c.Request.Context())
	if claims == nil {
		c.AbortWithStatusJSON(http.StatusForbidden, gin.H{"error": "not allowed"})
		return
	}
	act, err := h.Svc.Get(c.Request.Context(), c.Param("id"))
	if err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": err.Error()})
		return
	}
	if act == nil {
		c.JSON(http.StatusNotFound, gin.H{"error": "activation not found"})
		return
	}
	if act.RequesterID != claims.UserID && !claims.Admin {
		// Non-owner, non-admin: gate on the governance permission via the manage
		// flag the middleware would have set. We re-check leniently: only admins
		// or governance-perm holders reach the admin routes, so for the shared
		// self-service route we restrict to the owner.
		c.JSON(http.StatusForbidden, gin.H{"error": "not allowed"})
		return
	}
	c.JSON(http.StatusOK, gin.H{"activation": act})
}

// ----- Governance (PermBreakGlassManage / system:admin) -----

// List is the admin governance list across all requesters.
func (h *BreakGlassHandler) List(c *gin.Context) {
	if !h.ready(c) {
		return
	}
	limit, _ := strconv.Atoi(c.DefaultQuery("limit", "50"))
	offset, _ := strconv.Atoi(c.DefaultQuery("offset", "0"))
	f := repo.BreakGlassFilter{
		Status:     c.Query("status"),
		Mode:       c.Query("mode"),
		ResourceID: c.Query("resource_id"),
		Q:          c.Query("q"),
		Limit:      limit,
		Offset:     offset,
	}
	if v := c.Query("requester_id"); v != "" {
		if id, err := strconv.ParseUint(v, 10, 64); err == nil {
			f.RequesterID = id
		}
	}
	if v := c.Query("from"); v != "" {
		if t, err := time.Parse(time.RFC3339, v); err == nil {
			f.From = &t
		}
	}
	if v := c.Query("to"); v != "" {
		if t, err := time.Parse(time.RFC3339, v); err == nil {
			f.To = &t
		}
	}
	rows, total, err := h.Svc.List(c.Request.Context(), f)
	if err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": err.Error()})
		return
	}
	c.JSON(http.StatusOK, gin.H{"activations": rows, "total": total})
}

// Stats backs the governance overview tiles.
func (h *BreakGlassHandler) Stats(c *gin.Context) {
	if !h.ready(c) {
		return
	}
	st, err := h.Svc.Stats(c.Request.Context())
	if err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": err.Error()})
		return
	}
	c.JSON(http.StatusOK, st)
}

type revokeBreakGlassReq struct {
	Reason string `json:"reason"`
}

// Revoke is the admin kill-switch (route-gated on system:admin).
func (h *BreakGlassHandler) Revoke(c *gin.Context) {
	if !h.ready(c) {
		return
	}
	claims := auth.FromContext(c.Request.Context())
	if claims == nil {
		c.AbortWithStatusJSON(http.StatusForbidden, gin.H{"error": "not allowed"})
		return
	}
	var req revokeBreakGlassReq
	_ = c.ShouldBindJSON(&req)
	if strings.TrimSpace(req.Reason) == "" {
		c.JSON(http.StatusBadRequest, gin.H{"error": "a revoke reason is required"})
		return
	}
	act, err := h.Svc.Revoke(c.Request.Context(), c.Param("id"), claims.UserID, claims.Username, req.Reason)
	if err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"error": err.Error()})
		return
	}
	c.JSON(http.StatusOK, gin.H{"activation": act})
}

type reviewBreakGlassReq struct {
	Verdict string `json:"verdict"`
	Comment string `json:"comment"`
}

// SubmitReview records a post-use review (PermBreakGlassManage).
func (h *BreakGlassHandler) SubmitReview(c *gin.Context) {
	if !h.ready(c) {
		return
	}
	claims := auth.FromContext(c.Request.Context())
	if claims == nil {
		c.AbortWithStatusJSON(http.StatusForbidden, gin.H{"error": "not allowed"})
		return
	}
	var req reviewBreakGlassReq
	if err := c.ShouldBindJSON(&req); err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"error": "invalid request: " + err.Error()})
		return
	}
	act, err := h.Svc.SubmitReview(c.Request.Context(), c.Param("id"),
		claims.UserID, claims.Username, model.BreakGlassReviewVerdict(req.Verdict), req.Comment)
	if err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"error": err.Error()})
		return
	}
	c.JSON(http.StatusOK, gin.H{"activation": act})
}

// ----- Policy CRUD (PermBreakGlassManage) -----

type breakGlassPolicyReq struct {
	Name                 string  `json:"name"`
	Description          string  `json:"description"`
	Enabled              *bool   `json:"enabled"`
	ScopeType            string  `json:"scope_type"`
	ScopeID              *uint64 `json:"scope_id"`
	MaxDurationSec       int     `json:"max_duration_sec"`
	RequireIncidentRef   *bool   `json:"require_incident_ref"`
	RequireDualAuth      *bool   `json:"require_dual_auth"`
	AllowFailOpen        *bool   `json:"allow_fail_open"`
	RequirePostUseReview *bool   `json:"require_post_use_review"`
}

func (h *BreakGlassHandler) ListPolicies(c *gin.Context) {
	if !h.ready(c) {
		return
	}
	rows, err := h.Svc.ListPolicies(c.Request.Context())
	if err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": err.Error()})
		return
	}
	c.JSON(http.StatusOK, gin.H{"policies": rows})
}

func scopeTypeOf(s string) model.BreakGlassScopeType {
	switch model.BreakGlassScopeType(s) {
	case model.BreakGlassScopeNode:
		return model.BreakGlassScopeNode
	case model.BreakGlassScopeTag:
		return model.BreakGlassScopeTag
	default:
		return model.BreakGlassScopeAll
	}
}

func (h *BreakGlassHandler) CreatePolicy(c *gin.Context) {
	if !h.ready(c) {
		return
	}
	claims := auth.FromContext(c.Request.Context())
	var req breakGlassPolicyReq
	if err := c.ShouldBindJSON(&req); err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"error": "invalid request: " + err.Error()})
		return
	}
	if strings.TrimSpace(req.Name) == "" {
		c.JSON(http.StatusBadRequest, gin.H{"error": "name is required"})
		return
	}
	p := &model.BreakGlassPolicy{
		Name:                 strings.TrimSpace(req.Name),
		Description:          req.Description,
		Enabled:              boolOr(req.Enabled, true),
		ScopeType:            scopeTypeOf(req.ScopeType),
		ScopeID:              req.ScopeID,
		MaxDurationSec:       intOr(req.MaxDurationSec, 1800),
		RequireIncidentRef:   boolOr(req.RequireIncidentRef, true),
		RequireDualAuth:      boolOr(req.RequireDualAuth, false),
		AllowFailOpen:        boolOr(req.AllowFailOpen, false),
		RequirePostUseReview: boolOr(req.RequirePostUseReview, true),
	}
	if claims != nil {
		p.CreatedBy = claims.UserID
	}
	if err := h.Svc.CreatePolicy(c.Request.Context(), p); err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": err.Error()})
		return
	}
	c.JSON(http.StatusOK, gin.H{"policy": p})
}

func (h *BreakGlassHandler) UpdatePolicy(c *gin.Context) {
	if !h.ready(c) {
		return
	}
	id, err := strconv.ParseUint(c.Param("id"), 10, 64)
	if err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"error": "bad policy id"})
		return
	}
	p, err := h.Svc.FindPolicy(c.Request.Context(), id)
	if err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": err.Error()})
		return
	}
	if p == nil {
		c.JSON(http.StatusNotFound, gin.H{"error": "policy not found"})
		return
	}
	var req breakGlassPolicyReq
	if err := c.ShouldBindJSON(&req); err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"error": "invalid request: " + err.Error()})
		return
	}
	if strings.TrimSpace(req.Name) != "" {
		p.Name = strings.TrimSpace(req.Name)
	}
	p.Description = req.Description
	if req.Enabled != nil {
		p.Enabled = *req.Enabled
	}
	if req.ScopeType != "" {
		p.ScopeType = scopeTypeOf(req.ScopeType)
	}
	p.ScopeID = req.ScopeID
	if req.MaxDurationSec > 0 {
		p.MaxDurationSec = req.MaxDurationSec
	}
	if req.RequireIncidentRef != nil {
		p.RequireIncidentRef = *req.RequireIncidentRef
	}
	if req.RequireDualAuth != nil {
		p.RequireDualAuth = *req.RequireDualAuth
	}
	if req.AllowFailOpen != nil {
		p.AllowFailOpen = *req.AllowFailOpen
	}
	if req.RequirePostUseReview != nil {
		p.RequirePostUseReview = *req.RequirePostUseReview
	}
	if err := h.Svc.UpdatePolicy(c.Request.Context(), p); err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": err.Error()})
		return
	}
	c.JSON(http.StatusOK, gin.H{"policy": p})
}

func (h *BreakGlassHandler) DeletePolicy(c *gin.Context) {
	if !h.ready(c) {
		return
	}
	id, err := strconv.ParseUint(c.Param("id"), 10, 64)
	if err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"error": "bad policy id"})
		return
	}
	if err := h.Svc.DeletePolicy(c.Request.Context(), id); err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": err.Error()})
		return
	}
	c.JSON(http.StatusOK, gin.H{"ok": true})
}

func boolOr(v *bool, def bool) bool {
	if v == nil {
		return def
	}
	return *v
}

func intOr(v, def int) int {
	if v <= 0 {
		return def
	}
	return v
}
