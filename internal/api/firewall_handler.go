package api

import (
	"context"
	"errors"
	"net/http"
	"strconv"
	"time"

	"github.com/gin-gonic/gin"
	"github.com/michongs/wayfort/internal/auth"
	"github.com/michongs/wayfort/internal/firewall"
	"github.com/michongs/wayfort/internal/sse"
)

// FirewallHandler exposes the workspace v2 firewall management surface.
// Reads require an authenticated session with ActionConnect on the node;
// writes are additionally gated by PermFirewallManage at the route level.
//
// When the gateway is built without firewall wiring (older binary or a
// disabled config branch), routes.go constructs the handler via
// NewFirewallHandlerStub() with a human-readable reason; the 503 response
// body then carries that reason instead of a generic placeholder.
type FirewallHandler struct {
	Mgr               *firewall.Manager
	unavailableReason string
}

func NewFirewallHandler(mgr *firewall.Manager) *FirewallHandler {
	return &FirewallHandler{Mgr: mgr}
}

// NewFirewallHandlerStub returns a handler that always responds 503 with
// the given reason. Used by routes.go when rt.Firewall is nil so operators
// get a concrete diagnosis ("rebuild the gateway from latest source")
// instead of the previous opaque "firewall subsystem unavailable".
func NewFirewallHandlerStub(reason string) *FirewallHandler {
	return &FirewallHandler{Mgr: nil, unavailableReason: reason}
}

func (h *FirewallHandler) Status(c *gin.Context) {
	nodeID, claims, ok := h.ctx(c)
	if !ok {
		return
	}
	s, err := h.Mgr.Status(c.Request.Context(), claims.UserID, nodeID)
	if err != nil {
		respondFirewallErr(c, err)
		return
	}
	c.JSON(http.StatusOK, s)
}

func (h *FirewallHandler) ListRules(c *gin.Context) {
	nodeID, claims, ok := h.ctx(c)
	if !ok {
		return
	}
	rules, err := h.Mgr.ListRules(c.Request.Context(), claims.UserID, nodeID)
	if err != nil {
		respondFirewallErr(c, err)
		return
	}
	c.JSON(http.StatusOK, gin.H{"rules": rules})
}

func (h *FirewallHandler) AddRule(c *gin.Context) {
	nodeID, claims, ok := h.ctx(c)
	if !ok {
		return
	}
	var spec firewall.RuleSpec
	if err := c.ShouldBindJSON(&spec); err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"error": err.Error()})
		return
	}
	if err := h.Mgr.AddRule(c.Request.Context(), claims.UserID, nodeID, firewall.AuditClaims{
		UserID: claims.UserID, Username: claims.Username, ClientIP: c.ClientIP(),
	}, spec); err != nil {
		respondFirewallErr(c, err)
		return
	}
	c.JSON(http.StatusOK, gin.H{"ok": true})
}

func (h *FirewallHandler) DeleteRule(c *gin.Context) {
	nodeID, claims, ok := h.ctx(c)
	if !ok {
		return
	}
	idx, err := strconv.Atoi(c.Param("index"))
	if err != nil || idx <= 0 {
		c.JSON(http.StatusBadRequest, gin.H{"error": "invalid rule index"})
		return
	}
	if err := h.Mgr.DeleteRule(c.Request.Context(), claims.UserID, nodeID, firewall.AuditClaims{
		UserID: claims.UserID, Username: claims.Username, ClientIP: c.ClientIP(),
	}, idx); err != nil {
		respondFirewallErr(c, err)
		return
	}
	c.JSON(http.StatusOK, gin.H{"ok": true})
}

func (h *FirewallHandler) Enable(c *gin.Context)  { h.setEnabled(c, true) }
func (h *FirewallHandler) Disable(c *gin.Context) { h.setEnabled(c, false) }

func (h *FirewallHandler) setEnabled(c *gin.Context, on bool) {
	nodeID, claims, ok := h.ctx(c)
	if !ok {
		return
	}
	if err := h.Mgr.SetEnabled(c.Request.Context(), claims.UserID, nodeID, firewall.AuditClaims{
		UserID: claims.UserID, Username: claims.Username, ClientIP: c.ClientIP(),
	}, on); err != nil {
		respondFirewallErr(c, err)
		return
	}
	c.JSON(http.StatusOK, gin.H{"ok": true})
}

// Diagnose returns the same probe results the manager runs internally
// (uid / sudo availability / tool detection / probe stdout) so operators
// can debug "why doesn't the firewall tab work on this node" without
// reading gateway logs.
func (h *FirewallHandler) Diagnose(c *gin.Context) {
	nodeID, claims, ok := h.ctx(c)
	if !ok {
		return
	}
	d, err := h.Mgr.Diagnose(c.Request.Context(), claims.UserID, nodeID)
	if err != nil {
		respondFirewallErr(c, err)
		return
	}
	c.JSON(http.StatusOK, d)
}

// StatusStream pushes the live firewall snapshot (status + rules with hit
// counters + exposure + fail2ban summary) over SSE every 3s so the panel
// updates without polling.
func (h *FirewallHandler) StatusStream(c *gin.Context) {
	nodeID, claims, ok := h.ctx(c)
	if !ok {
		return
	}
	produce := func(ctx context.Context) (any, error) {
		return h.Mgr.LiveSnapshot(ctx, claims.UserID, nodeID)
	}
	first, err := produce(c.Request.Context())
	if err != nil {
		respondFirewallErr(c, err)
		return
	}
	sse.Snapshots(c, 3*time.Second, first, produce)
}

// Conntrack returns a one-shot snapshot of active connections.
func (h *FirewallHandler) Conntrack(c *gin.Context) {
	nodeID, claims, ok := h.ctx(c)
	if !ok {
		return
	}
	s, err := h.Mgr.Conntrack(c.Request.Context(), claims.UserID, nodeID)
	if err != nil {
		respondFirewallErr(c, err)
		return
	}
	c.JSON(http.StatusOK, s)
}

// ConntrackStream pushes the active-connection table over SSE every 2s.
func (h *FirewallHandler) ConntrackStream(c *gin.Context) {
	nodeID, claims, ok := h.ctx(c)
	if !ok {
		return
	}
	produce := func(ctx context.Context) (any, error) {
		return h.Mgr.Conntrack(ctx, claims.UserID, nodeID)
	}
	first, err := produce(c.Request.Context())
	if err != nil {
		respondFirewallErr(c, err)
		return
	}
	sse.Snapshots(c, 2*time.Second, first, produce)
}

// LogsStream follows firewall log lines over SSE (event: line / done).
func (h *FirewallHandler) LogsStream(c *gin.Context) {
	nodeID, claims, ok := h.ctx(c)
	if !ok {
		return
	}
	sse.Lines(c, func(ctx context.Context, emit func(string)) error {
		return h.Mgr.LogsStream(ctx, claims.UserID, nodeID, emit)
	})
}

// InsertRule inserts a rule at a 1-based position. Gated by firewall:manage.
func (h *FirewallHandler) InsertRule(c *gin.Context) {
	nodeID, claims, ok := h.ctx(c)
	if !ok {
		return
	}
	var ins firewall.RuleInsert
	if err := c.ShouldBindJSON(&ins); err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"error": err.Error()})
		return
	}
	if err := h.Mgr.InsertRule(c.Request.Context(), claims.UserID, nodeID, h.audit(c, claims), ins); err != nil {
		respondFirewallErr(c, err)
		return
	}
	c.JSON(http.StatusOK, gin.H{"ok": true})
}

// EditRule replaces a rule in place (index from URL, body carries the new spec +
// optional nft handle/chain). Gated by firewall:manage.
func (h *FirewallHandler) EditRule(c *gin.Context) {
	nodeID, claims, ok := h.ctx(c)
	if !ok {
		return
	}
	var ed firewall.RuleEdit
	if err := c.ShouldBindJSON(&ed); err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"error": err.Error()})
		return
	}
	if idx, err := strconv.Atoi(c.Param("index")); err == nil {
		ed.Index = idx
	}
	if err := h.Mgr.EditRule(c.Request.Context(), claims.UserID, nodeID, h.audit(c, claims), ed); err != nil {
		respondFirewallErr(c, err)
		return
	}
	c.JSON(http.StatusOK, gin.H{"ok": true})
}

// MoveRule reorders a rule. Gated by firewall:manage.
func (h *FirewallHandler) MoveRule(c *gin.Context) {
	nodeID, claims, ok := h.ctx(c)
	if !ok {
		return
	}
	var mv firewall.RuleMove
	if err := c.ShouldBindJSON(&mv); err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"error": err.Error()})
		return
	}
	if err := h.Mgr.MoveRule(c.Request.Context(), claims.UserID, nodeID, h.audit(c, claims), mv); err != nil {
		respondFirewallErr(c, err)
		return
	}
	c.JSON(http.StatusOK, gin.H{"ok": true})
}

type fwBulkBody struct {
	Indexes []int `json:"indexes"`
}

// BulkDelete removes several rules at once. Gated by firewall:manage.
func (h *FirewallHandler) BulkDelete(c *gin.Context) {
	nodeID, claims, ok := h.ctx(c)
	if !ok {
		return
	}
	var body fwBulkBody
	if err := c.ShouldBindJSON(&body); err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"error": err.Error()})
		return
	}
	n, err := h.Mgr.BulkDelete(c.Request.Context(), claims.UserID, nodeID, h.audit(c, claims), body.Indexes)
	if err != nil {
		respondFirewallErr(c, err)
		return
	}
	c.JSON(http.StatusOK, gin.H{"ok": true, "deleted": n})
}

// Persist writes the live ruleset to disk. Gated by firewall:manage.
func (h *FirewallHandler) Persist(c *gin.Context) {
	nodeID, claims, ok := h.ctx(c)
	if !ok {
		return
	}
	if err := h.Mgr.Persist(c.Request.Context(), claims.UserID, nodeID, h.audit(c, claims)); err != nil {
		respondFirewallErr(c, err)
		return
	}
	c.JSON(http.StatusOK, gin.H{"ok": true})
}

// ProbeInstall reports distro / package manager / installed tools so the UI can
// offer the right one-click install. Read-only.
func (h *FirewallHandler) ProbeInstall(c *gin.Context) {
	nodeID, claims, ok := h.ctx(c)
	if !ok {
		return
	}
	p, err := h.Mgr.ProbeInstall(c.Request.Context(), claims.UserID, nodeID)
	if err != nil {
		respondFirewallErr(c, err)
		return
	}
	c.JSON(http.StatusOK, p)
}

// InstallStream installs the firewall tool named by ?tool=ufw|nft over SSE.
// Gated by firewall:manage.
func (h *FirewallHandler) InstallStream(c *gin.Context) {
	nodeID, claims, ok := h.ctx(c)
	if !ok {
		return
	}
	ac := h.audit(c, claims)
	tool := c.Query("tool")
	sse.Lines(c, func(ctx context.Context, emit func(string)) error {
		switch tool {
		case "nft", "nftables":
			return h.Mgr.InstallNft(ctx, claims.UserID, nodeID, ac, emit)
		default:
			return h.Mgr.InstallUFW(ctx, claims.UserID, nodeID, ac, emit)
		}
	})
}

// InstallF2BStream installs fail2ban over SSE. Gated by firewall:manage.
func (h *FirewallHandler) InstallF2BStream(c *gin.Context) {
	nodeID, claims, ok := h.ctx(c)
	if !ok {
		return
	}
	ac := h.audit(c, claims)
	sse.Lines(c, func(ctx context.Context, emit func(string)) error {
		return h.Mgr.InstallFail2ban(ctx, claims.UserID, nodeID, ac, emit)
	})
}

// Presets / Templates are static catalogues (no SSH). Read-only.
func (h *FirewallHandler) Presets(c *gin.Context) {
	if _, _, ok := h.ctx(c); !ok {
		return
	}
	c.JSON(http.StatusOK, gin.H{"presets": firewall.PortPresets})
}
func (h *FirewallHandler) Templates(c *gin.Context) {
	if _, _, ok := h.ctx(c); !ok {
		return
	}
	c.JSON(http.StatusOK, gin.H{"templates": firewall.Templates})
}

// Exposure lists listening ports with their firewall verdict. Read-only.
func (h *FirewallHandler) Exposure(c *gin.Context) {
	nodeID, claims, ok := h.ctx(c)
	if !ok {
		return
	}
	ports, err := h.Mgr.ExposureList(c.Request.Context(), claims.UserID, nodeID)
	if err != nil {
		respondFirewallErr(c, err)
		return
	}
	c.JSON(http.StatusOK, gin.H{"ports": ports})
}

// Export dumps the current ruleset for backup. Read-only.
func (h *FirewallHandler) Export(c *gin.Context) {
	nodeID, claims, ok := h.ctx(c)
	if !ok {
		return
	}
	d, err := h.Mgr.ExportRuleset(c.Request.Context(), claims.UserID, nodeID)
	if err != nil {
		respondFirewallErr(c, err)
		return
	}
	c.Header("Cache-Control", "no-store")
	c.JSON(http.StatusOK, d)
}

type fwImportBody struct {
	Content string `json:"content" binding:"required"`
}

// ImportPreview dry-runs an import. Read-only.
func (h *FirewallHandler) ImportPreview(c *gin.Context) {
	nodeID, claims, ok := h.ctx(c)
	if !ok {
		return
	}
	var body fwImportBody
	if err := c.ShouldBindJSON(&body); err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"error": err.Error()})
		return
	}
	plan, err := h.Mgr.ImportPreview(c.Request.Context(), claims.UserID, nodeID, body.Content)
	if err != nil {
		respondFirewallErr(c, err)
		return
	}
	c.JSON(http.StatusOK, plan)
}

// SafeApply runs a change with auto-rollback protection (high-risk changes
// require confirm=true) and returns the arm token + deadline. Gated by
// firewall:manage.
func (h *FirewallHandler) SafeApply(c *gin.Context) {
	nodeID, claims, ok := h.ctx(c)
	if !ok {
		return
	}
	var req firewall.ApplyRequest
	if err := c.ShouldBindJSON(&req); err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"error": err.Error()})
		return
	}
	res, err := h.Mgr.SafeApply(c.Request.Context(), claims.UserID, nodeID, h.audit(c, claims), req)
	if err != nil {
		respondFirewallErr(c, err)
		return
	}
	c.JSON(http.StatusOK, res)
}

type fwTokenBody struct {
	ArmToken string `json:"arm_token"`
}

// CommitApply cancels a pending rollback and persists. Gated by firewall:manage.
func (h *FirewallHandler) CommitApply(c *gin.Context) {
	nodeID, claims, ok := h.ctx(c)
	if !ok {
		return
	}
	var body fwTokenBody
	_ = c.ShouldBindJSON(&body)
	if err := h.Mgr.CommitApply(c.Request.Context(), claims.UserID, nodeID, h.audit(c, claims), body.ArmToken); err != nil {
		respondFirewallErr(c, err)
		return
	}
	c.JSON(http.StatusOK, gin.H{"ok": true})
}

// Rollback triggers a pending rollback immediately. Gated by firewall:manage.
func (h *FirewallHandler) Rollback(c *gin.Context) {
	nodeID, claims, ok := h.ctx(c)
	if !ok {
		return
	}
	var body fwTokenBody
	_ = c.ShouldBindJSON(&body)
	if err := h.Mgr.RollbackNow(c.Request.Context(), claims.UserID, nodeID, h.audit(c, claims), body.ArmToken); err != nil {
		respondFirewallErr(c, err)
		return
	}
	c.JSON(http.StatusOK, gin.H{"ok": true})
}

// Fail2ban returns the full fail2ban status (jails + banned IPs). Read-only.
func (h *FirewallHandler) Fail2ban(c *gin.Context) {
	nodeID, claims, ok := h.ctx(c)
	if !ok {
		return
	}
	s, err := h.Mgr.F2BStatus(c.Request.Context(), claims.UserID, nodeID)
	if err != nil {
		respondFirewallErr(c, err)
		return
	}
	c.JSON(http.StatusOK, s)
}

// Fail2banStream pushes the fail2ban status over SSE every 5s.
func (h *FirewallHandler) Fail2banStream(c *gin.Context) {
	nodeID, claims, ok := h.ctx(c)
	if !ok {
		return
	}
	produce := func(ctx context.Context) (any, error) {
		return h.Mgr.F2BStatus(ctx, claims.UserID, nodeID)
	}
	first, err := produce(c.Request.Context())
	if err != nil {
		respondFirewallErr(c, err)
		return
	}
	sse.Snapshots(c, 5*time.Second, first, produce)
}

type fwF2BBody struct {
	Jail string `json:"jail" binding:"required"`
	IP   string `json:"ip" binding:"required"`
}

// F2BBan / F2BUnban add/remove a fail2ban ban. Gated by firewall:manage.
func (h *FirewallHandler) F2BBan(c *gin.Context)   { h.f2bAction(c, true) }
func (h *FirewallHandler) F2BUnban(c *gin.Context) { h.f2bAction(c, false) }

func (h *FirewallHandler) f2bAction(c *gin.Context, ban bool) {
	nodeID, claims, ok := h.ctx(c)
	if !ok {
		return
	}
	var body fwF2BBody
	if err := c.ShouldBindJSON(&body); err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"error": err.Error()})
		return
	}
	var err error
	if ban {
		err = h.Mgr.F2BBan(c.Request.Context(), claims.UserID, nodeID, h.audit(c, claims), body.Jail, body.IP)
	} else {
		err = h.Mgr.F2BUnban(c.Request.Context(), claims.UserID, nodeID, h.audit(c, claims), body.Jail, body.IP)
	}
	if err != nil {
		respondFirewallErr(c, err)
		return
	}
	c.JSON(http.StatusOK, gin.H{"ok": true})
}

func (h *FirewallHandler) audit(c *gin.Context, claims *auth.Claims) firewall.AuditClaims {
	return firewall.AuditClaims{UserID: claims.UserID, Username: claims.Username, ClientIP: c.ClientIP()}
}

func (h *FirewallHandler) ctx(c *gin.Context) (uint64, *auth.Claims, bool) {
	if h == nil || h.Mgr == nil {
		msg := "firewall subsystem unavailable"
		if h != nil && h.unavailableReason != "" {
			msg = h.unavailableReason
		}
		c.JSON(http.StatusServiceUnavailable, gin.H{
			"error": msg,
			"code":  "subsystem_unavailable",
		})
		return 0, nil, false
	}
	claims := auth.FromContext(c.Request.Context())
	if claims == nil || claims.Anonymous {
		c.JSON(http.StatusForbidden, gin.H{"error": "not allowed"})
		return 0, nil, false
	}
	nodeID, err := strconv.ParseUint(c.Param("id"), 10, 64)
	if err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"error": "bad node id"})
		return 0, nil, false
	}
	return nodeID, claims, true
}

// respondFirewallErr maps typed errors → HTTP statuses with a machine code
// for the frontend to render contextual hints (vs. dumping a raw stderr
// blob in a toast).
func respondFirewallErr(c *gin.Context, err error) {
	switch {
	case errors.Is(err, firewall.ErrUnauthorized):
		c.JSON(http.StatusForbidden, gin.H{"error": err.Error(), "code": "unauthorized"})
	case errors.Is(err, firewall.ErrDisabled):
		c.JSON(http.StatusServiceUnavailable, gin.H{"error": err.Error(), "code": "disabled"})
	case errors.Is(err, firewall.ErrNoTool):
		c.JSON(http.StatusNotImplemented, gin.H{"error": err.Error(), "code": "no_tool"})
	case errors.Is(err, firewall.ErrPermissionDenied):
		c.JSON(http.StatusForbidden, gin.H{"error": err.Error(), "code": "permission_denied"})
	case errors.Is(err, firewall.ErrUnreachable):
		c.JSON(http.StatusBadGateway, gin.H{"error": err.Error(), "code": "unreachable"})
	case errors.Is(err, firewall.ErrParse):
		c.JSON(http.StatusBadGateway, gin.H{"error": err.Error(), "code": "parse_error"})
	case errors.Is(err, firewall.ErrConfirmRequired):
		c.JSON(http.StatusConflict, gin.H{"error": err.Error(), "code": "confirm_required"})
	case errors.Is(err, firewall.ErrAlreadyArmed):
		c.JSON(http.StatusConflict, gin.H{"error": err.Error(), "code": "already_armed"})
	case errors.Is(err, firewall.ErrNoSnapshot):
		c.JSON(http.StatusNotFound, gin.H{"error": err.Error(), "code": "no_snapshot"})
	case errors.Is(err, firewall.ErrEditUnsupported):
		c.JSON(http.StatusUnprocessableEntity, gin.H{"error": err.Error(), "code": "edit_unsupported"})
	case errors.Is(err, firewall.ErrSSHGuardFail):
		c.JSON(http.StatusConflict, gin.H{"error": err.Error(), "code": "ssh_guard_fail"})
	case errors.Is(err, firewall.ErrBadSpec), errors.Is(err, firewall.ErrBadArg):
		c.JSON(http.StatusBadRequest, gin.H{"error": err.Error(), "code": "bad_request"})
	case errors.Is(err, firewall.ErrNotInstalled):
		c.JSON(http.StatusConflict, gin.H{"error": err.Error(), "code": "not_installed"})
	default:
		c.JSON(http.StatusBadGateway, gin.H{"error": err.Error()})
	}
}
