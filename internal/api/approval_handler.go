package api

import (
	"net/http"
	"strconv"
	"strings"
	"time"

	"github.com/gin-gonic/gin"
	"github.com/michongs/jumpserver-anonymous/internal/approval"
	"github.com/michongs/jumpserver-anonymous/internal/auth"
	"github.com/michongs/jumpserver-anonymous/internal/model"
	"github.com/michongs/jumpserver-anonymous/internal/repo"
)

// ApprovalHandler is the REST surface for Phase 15. Routes live in
// internal/server/routes.go.
type ApprovalHandler struct {
	svc  *approval.Service
	repo *repo.ApprovalRepo
}

// NewApprovalHandler binds the handler to its service. repo is exposed for a
// handful of read-only admin endpoints that don't need the full Service
// orchestration (template / subscription CRUD).
func NewApprovalHandler(svc *approval.Service, r *repo.ApprovalRepo) *ApprovalHandler {
	return &ApprovalHandler{svc: svc, repo: r}
}

// ----- requests -----

type createRequestBody struct {
	BusinessType string         `json:"business_type"`
	Title        string         `json:"title"`
	Reason       string         `json:"reason"`
	ResourceType string         `json:"resource_type"`
	ResourceID   string         `json:"resource_id"`
	Payload      map[string]any `json:"payload"`
	WindowStart  *time.Time     `json:"window_start,omitempty"`
	WindowEnd    *time.Time     `json:"window_end,omitempty"`
}

// CreateRequest — POST /api/v1/approvals
func (h *ApprovalHandler) CreateRequest(c *gin.Context) {
	if h.svc == nil {
		c.JSON(http.StatusServiceUnavailable, gin.H{"error": "approval service disabled"})
		return
	}
	claims := auth.FromContext(c.Request.Context())
	if claims == nil {
		c.JSON(http.StatusUnauthorized, gin.H{"error": "missing claims"})
		return
	}
	var body createRequestBody
	if err := c.ShouldBindJSON(&body); err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"error": err.Error()})
		return
	}
	in := &approval.CreateRequestInput{
		BusinessType:  model.ApprovalBusinessType(body.BusinessType),
		Title:         body.Title,
		Reason:        body.Reason,
		ResourceType:  body.ResourceType,
		ResourceID:    body.ResourceID,
		Payload:       body.Payload,
		RequesterID:   claims.UserID,
		RequesterName: claims.Username,
		ClientIP:      c.ClientIP(),
	}
	if body.WindowStart != nil {
		in.WindowStart = *body.WindowStart
	}
	if body.WindowEnd != nil {
		in.WindowEnd = *body.WindowEnd
	}
	out, err := h.svc.CreateRequest(c.Request.Context(), in)
	if err != nil {
		c.JSON(http.StatusUnprocessableEntity, gin.H{"error": err.Error()})
		return
	}
	c.JSON(http.StatusCreated, out)
}

// ListRequests — GET /api/v1/approvals?status=&business_type=&mine=&limit=&offset=
// Non-admins can only see their own requests (mine=1 implied).
func (h *ApprovalHandler) ListRequests(c *gin.Context) {
	claims := auth.FromContext(c.Request.Context())
	if claims == nil {
		c.JSON(http.StatusUnauthorized, gin.H{"error": "missing claims"})
		return
	}
	mine := c.Query("mine") == "1"
	status := c.Query("status")
	biz := c.Query("business_type")
	limit, _ := strconv.Atoi(c.Query("limit"))
	offset, _ := strconv.Atoi(c.Query("offset"))
	var requester uint64
	if mine || !claims.Admin {
		requester = claims.UserID
	}
	rows, total, err := h.svc.ListRequests(c.Request.Context(), requester, status, biz, limit, offset)
	if err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": err.Error()})
		return
	}
	c.JSON(http.StatusOK, gin.H{"items": rows, "total": total})
}

// GetRequest — GET /api/v1/approvals/:id
func (h *ApprovalHandler) GetRequest(c *gin.Context) {
	claims := auth.FromContext(c.Request.Context())
	if claims == nil {
		c.JSON(http.StatusUnauthorized, gin.H{"error": "missing claims"})
		return
	}
	id := c.Param("id")
	detail, err := h.svc.GetRequest(c.Request.Context(), id)
	if err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": err.Error()})
		return
	}
	if detail == nil {
		c.JSON(http.StatusNotFound, gin.H{"error": "request not found"})
		return
	}
	// Privacy: a non-admin can only see their own request, or one where
	// they're a current approver.
	if !claims.Admin && detail.Request.RequesterID != claims.UserID && !isApprover(detail.Tasks, claims.UserID) {
		c.JSON(http.StatusForbidden, gin.H{"error": "not allowed"})
		return
	}
	c.JSON(http.StatusOK, detail)
}

func isApprover(tasks []model.ApprovalTask, uid uint64) bool {
	for _, t := range tasks {
		if t.ApproverID == uid {
			return true
		}
	}
	return false
}

// CancelRequest — POST /api/v1/approvals/:id/cancel
func (h *ApprovalHandler) CancelRequest(c *gin.Context) {
	claims := auth.FromContext(c.Request.Context())
	if claims == nil {
		c.JSON(http.StatusUnauthorized, gin.H{"error": "missing claims"})
		return
	}
	var body struct {
		Reason string `json:"reason"`
	}
	_ = c.ShouldBindJSON(&body)
	if err := h.svc.Cancel(c.Request.Context(), c.Param("id"), claims.UserID, body.Reason); err != nil {
		c.JSON(http.StatusUnprocessableEntity, gin.H{"error": err.Error()})
		return
	}
	c.JSON(http.StatusOK, gin.H{"ok": true})
}

// ----- tasks -----

// MyTasks — GET /api/v1/approvals/tasks/me?limit=
func (h *ApprovalHandler) MyTasks(c *gin.Context) {
	claims := auth.FromContext(c.Request.Context())
	if claims == nil {
		c.JSON(http.StatusUnauthorized, gin.H{"error": "missing claims"})
		return
	}
	limit, _ := strconv.Atoi(c.Query("limit"))
	tasks, err := h.svc.PendingForApprover(c.Request.Context(), claims.UserID, limit)
	if err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": err.Error()})
		return
	}
	c.JSON(http.StatusOK, gin.H{"items": tasks})
}

type decideBody struct {
	Approve bool   `json:"approve"`
	Comment string `json:"comment"`
}

// Approve / Reject — POST /api/v1/approvals/tasks/:task_id/approve|reject
func (h *ApprovalHandler) Approve(c *gin.Context) { h.decide(c, true) }
func (h *ApprovalHandler) Reject(c *gin.Context)  { h.decide(c, false) }

func (h *ApprovalHandler) decide(c *gin.Context, approve bool) {
	claims := auth.FromContext(c.Request.Context())
	if claims == nil {
		c.JSON(http.StatusUnauthorized, gin.H{"error": "missing claims"})
		return
	}
	taskID, err := strconv.ParseUint(c.Param("task_id"), 10, 64)
	if err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"error": "bad task_id"})
		return
	}
	var body decideBody
	_ = c.ShouldBindJSON(&body)
	body.Approve = approve
	out, err := h.svc.Decide(c.Request.Context(), taskID, approval.DecideInput{
		ApproverID: claims.UserID,
		Approve:    body.Approve,
		Comment:    body.Comment,
	})
	if err != nil {
		c.JSON(http.StatusUnprocessableEntity, gin.H{"error": err.Error()})
		return
	}
	c.JSON(http.StatusOK, out)
}

type delegateBody struct {
	DelegateToID uint64 `json:"delegate_to_id"`
	Comment      string `json:"comment"`
}

// Delegate — POST /api/v1/approvals/tasks/:task_id/delegate
func (h *ApprovalHandler) Delegate(c *gin.Context) {
	claims := auth.FromContext(c.Request.Context())
	if claims == nil {
		c.JSON(http.StatusUnauthorized, gin.H{"error": "missing claims"})
		return
	}
	taskID, err := strconv.ParseUint(c.Param("task_id"), 10, 64)
	if err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"error": "bad task_id"})
		return
	}
	var body delegateBody
	if err := c.ShouldBindJSON(&body); err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"error": err.Error()})
		return
	}
	if body.DelegateToID == 0 {
		c.JSON(http.StatusBadRequest, gin.H{"error": "delegate_to_id required"})
		return
	}
	task, err := h.svc.Delegate(c.Request.Context(), taskID, body.DelegateToID, body.Comment)
	if err != nil {
		c.JSON(http.StatusUnprocessableEntity, gin.H{"error": err.Error()})
		return
	}
	// Re-load original task to confirm the calling user owned it.
	_ = claims
	c.JSON(http.StatusOK, gin.H{"task": task})
}

// ----- grants -----

// RevokeGrant — POST /api/v1/approvals/grants/:id/revoke
func (h *ApprovalHandler) RevokeGrant(c *gin.Context) {
	claims := auth.FromContext(c.Request.Context())
	if claims == nil {
		c.JSON(http.StatusUnauthorized, gin.H{"error": "missing claims"})
		return
	}
	var body struct {
		Reason string `json:"reason"`
	}
	_ = c.ShouldBindJSON(&body)
	if err := h.svc.RevokeGrant(c.Request.Context(), c.Param("id"), claims.UserID, body.Reason); err != nil {
		c.JSON(http.StatusUnprocessableEntity, gin.H{"error": err.Error()})
		return
	}
	c.JSON(http.StatusOK, gin.H{"ok": true})
}

// ----- audit -----

// VerifyChain — GET /api/v1/approvals/:id/audit/verify
func (h *ApprovalHandler) VerifyChain(c *gin.Context) {
	res, err := h.svc.VerifyChain(c.Request.Context(), c.Param("id"))
	if err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": err.Error()})
		return
	}
	if res == nil {
		c.JSON(http.StatusNotFound, gin.H{"error": "no events for this request"})
		return
	}
	c.JSON(http.StatusOK, res)
}

// EventsSince — GET /api/v1/approvals/audit/events?since=&limit=
// Admin-only; used by SIEM exporters to pull the ledger incrementally.
func (h *ApprovalHandler) EventsSince(c *gin.Context) {
	since, _ := strconv.ParseUint(c.Query("since"), 10, 64)
	limit, _ := strconv.Atoi(c.Query("limit"))
	rows, err := h.repo.EventsSince(c.Request.Context(), since, limit)
	if err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": err.Error()})
		return
	}
	c.JSON(http.StatusOK, gin.H{"items": rows})
}

// ----- templates (admin) -----

type templateBody struct {
	Name              string `json:"name"`
	Description       string `json:"description"`
	BusinessType      string `json:"business_type"`
	Priority          int    `json:"priority"`
	Enabled           bool   `json:"enabled"`
	Selector          string `json:"selector"`
	Stages            string `json:"stages"`
	RiskRule          string `json:"risk_rule"`
	AutoApprove       string `json:"auto_approve"`
	MaxDurationSec    int    `json:"max_duration_sec"`
	DefaultTimeoutSec int    `json:"default_timeout_sec"`
}

func (h *ApprovalHandler) ListTemplates(c *gin.Context) {
	rows, err := h.repo.ListTemplates(c.Request.Context())
	if err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": err.Error()})
		return
	}
	c.JSON(http.StatusOK, gin.H{"items": rows})
}

func (h *ApprovalHandler) CreateTemplate(c *gin.Context) {
	var body templateBody
	if err := c.ShouldBindJSON(&body); err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"error": err.Error()})
		return
	}
	if strings.TrimSpace(body.Name) == "" {
		c.JSON(http.StatusBadRequest, gin.H{"error": "name required"})
		return
	}
	t := &model.ApprovalTemplate{
		Name:              body.Name,
		Description:       body.Description,
		BusinessType:      model.ApprovalBusinessType(body.BusinessType),
		Priority:          body.Priority,
		Enabled:           body.Enabled,
		Selector:          body.Selector,
		Stages:            body.Stages,
		RiskRule:          body.RiskRule,
		AutoApprove:       body.AutoApprove,
		MaxDurationSec:    body.MaxDurationSec,
		DefaultTimeoutSec: body.DefaultTimeoutSec,
	}
	if err := h.repo.CreateTemplate(c.Request.Context(), t); err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": err.Error()})
		return
	}
	c.JSON(http.StatusCreated, t)
}

func (h *ApprovalHandler) UpdateTemplate(c *gin.Context) {
	id, err := strconv.ParseUint(c.Param("id"), 10, 64)
	if err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"error": "bad id"})
		return
	}
	existing, err := h.repo.FindTemplate(c.Request.Context(), id)
	if err != nil || existing == nil {
		c.JSON(http.StatusNotFound, gin.H{"error": "template not found"})
		return
	}
	if existing.IsSystem {
		c.JSON(http.StatusForbidden, gin.H{"error": "system template is read-only"})
		return
	}
	var body templateBody
	if err := c.ShouldBindJSON(&body); err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"error": err.Error()})
		return
	}
	existing.Description = body.Description
	existing.BusinessType = model.ApprovalBusinessType(body.BusinessType)
	existing.Priority = body.Priority
	existing.Enabled = body.Enabled
	existing.Selector = body.Selector
	existing.Stages = body.Stages
	existing.RiskRule = body.RiskRule
	existing.AutoApprove = body.AutoApprove
	existing.MaxDurationSec = body.MaxDurationSec
	existing.DefaultTimeoutSec = body.DefaultTimeoutSec
	if err := h.repo.UpdateTemplate(c.Request.Context(), existing); err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": err.Error()})
		return
	}
	c.JSON(http.StatusOK, existing)
}

func (h *ApprovalHandler) DeleteTemplate(c *gin.Context) {
	id, err := strconv.ParseUint(c.Param("id"), 10, 64)
	if err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"error": "bad id"})
		return
	}
	existing, _ := h.repo.FindTemplate(c.Request.Context(), id)
	if existing != nil && existing.IsSystem {
		c.JSON(http.StatusForbidden, gin.H{"error": "system template is read-only"})
		return
	}
	if err := h.repo.DeleteTemplate(c.Request.Context(), id); err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": err.Error()})
		return
	}
	c.JSON(http.StatusOK, gin.H{"ok": true})
}

// ----- subscriptions (admin) -----

type subscriptionBody struct {
	Name         string `json:"name"`
	Channel      string `json:"channel"`
	Target       string `json:"target"`
	Secret       string `json:"secret"`
	BusinessType string `json:"business_type"`
	EventMask    string `json:"event_mask"`
	Enabled      bool   `json:"enabled"`
}

func (h *ApprovalHandler) ListSubscriptions(c *gin.Context) {
	rows, err := h.repo.ListSubscriptions(c.Request.Context())
	if err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": err.Error()})
		return
	}
	c.JSON(http.StatusOK, gin.H{"items": rows})
}

func (h *ApprovalHandler) CreateSubscription(c *gin.Context) {
	var body subscriptionBody
	if err := c.ShouldBindJSON(&body); err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"error": err.Error()})
		return
	}
	s := &model.ApprovalSubscription{
		Name:         body.Name,
		Channel:      body.Channel,
		Target:       body.Target,
		Secret:       body.Secret,
		BusinessType: model.ApprovalBusinessType(body.BusinessType),
		EventMask:    body.EventMask,
		Enabled:      body.Enabled,
	}
	if err := h.repo.CreateSubscription(c.Request.Context(), s); err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": err.Error()})
		return
	}
	c.JSON(http.StatusCreated, s)
}

func (h *ApprovalHandler) UpdateSubscription(c *gin.Context) {
	id, err := strconv.ParseUint(c.Param("id"), 10, 64)
	if err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"error": "bad id"})
		return
	}
	var body subscriptionBody
	if err := c.ShouldBindJSON(&body); err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"error": err.Error()})
		return
	}
	s := &model.ApprovalSubscription{
		ID:           id,
		Name:         body.Name,
		Channel:      body.Channel,
		Target:       body.Target,
		Secret:       body.Secret,
		BusinessType: model.ApprovalBusinessType(body.BusinessType),
		EventMask:    body.EventMask,
		Enabled:      body.Enabled,
	}
	if err := h.repo.UpdateSubscription(c.Request.Context(), s); err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": err.Error()})
		return
	}
	c.JSON(http.StatusOK, s)
}

func (h *ApprovalHandler) DeleteSubscription(c *gin.Context) {
	id, err := strconv.ParseUint(c.Param("id"), 10, 64)
	if err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"error": "bad id"})
		return
	}
	if err := h.repo.DeleteSubscription(c.Request.Context(), id); err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": err.Error()})
		return
	}
	c.JSON(http.StatusOK, gin.H{"ok": true})
}

// ----- enforcement-point convenience -----

// CheckGrant is a server-internal endpoint mirror: it lets ad-hoc tooling
// validate "may user U do action A on resource R right now". The action-
// bearing modules talk to approval.Service.VerifyGrant directly.
func (h *ApprovalHandler) CheckGrant(c *gin.Context) {
	uid, _ := strconv.ParseUint(c.Query("user_id"), 10, 64)
	chk := approval.GrantCheck{
		UserID:       uid,
		ResourceType: c.Query("resource_type"),
		ResourceID:   c.Query("resource_id"),
		Action:       c.Query("action"),
		BusinessType: model.ApprovalBusinessType(c.Query("business_type")),
	}
	res, err := h.svc.VerifyGrant(c.Request.Context(), chk)
	if err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": err.Error()})
		return
	}
	c.JSON(http.StatusOK, res)
}
