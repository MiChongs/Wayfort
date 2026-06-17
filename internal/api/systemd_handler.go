package api

import (
	"errors"
	"net/http"
	"strconv"

	"github.com/gin-gonic/gin"
	"github.com/michongs/wayfort/internal/auth"
	"github.com/michongs/wayfort/internal/systemd"
)

// SystemdHandler exposes the workspace ops-dock systemd service surface.
// Reads (status / units / show / journal) require an authenticated session with
// ActionConnect on the node; control actions are additionally gated by
// PermServiceManage at the route level.
//
// When the gateway is built without systemd wiring, routes.go constructs the
// handler via NewSystemdHandlerStub() so the 503 body carries a concrete reason.
type SystemdHandler struct {
	Mgr               *systemd.Manager
	unavailableReason string
}

func NewSystemdHandler(mgr *systemd.Manager) *SystemdHandler {
	return &SystemdHandler{Mgr: mgr}
}

func NewSystemdHandlerStub(reason string) *SystemdHandler {
	return &SystemdHandler{Mgr: nil, unavailableReason: reason}
}

func (h *SystemdHandler) Status(c *gin.Context) {
	nodeID, claims, ok := h.ctx(c)
	if !ok {
		return
	}
	s, err := h.Mgr.Status(c.Request.Context(), claims.UserID, nodeID)
	if err != nil {
		respondSystemdErr(c, err)
		return
	}
	c.Header("Cache-Control", "no-store")
	c.JSON(http.StatusOK, s)
}

func (h *SystemdHandler) ListUnits(c *gin.Context) {
	nodeID, claims, ok := h.ctx(c)
	if !ok {
		return
	}
	units, err := h.Mgr.ListUnits(c.Request.Context(), claims.UserID, nodeID, c.Query("filter"))
	if err != nil {
		respondSystemdErr(c, err)
		return
	}
	c.Header("Cache-Control", "no-store")
	c.JSON(http.StatusOK, gin.H{"units": units})
}

func (h *SystemdHandler) Detail(c *gin.Context) {
	nodeID, claims, ok := h.ctx(c)
	if !ok {
		return
	}
	name := c.Query("name")
	if name == "" {
		c.JSON(http.StatusBadRequest, gin.H{"error": "missing unit name"})
		return
	}
	lines, _ := strconv.Atoi(c.DefaultQuery("lines", "200"))
	d, err := h.Mgr.Detail(c.Request.Context(), claims.UserID, nodeID, name, lines)
	if err != nil {
		respondSystemdErr(c, err)
		return
	}
	c.Header("Cache-Control", "no-store")
	c.JSON(http.StatusOK, d)
}

func (h *SystemdHandler) Journal(c *gin.Context) {
	nodeID, claims, ok := h.ctx(c)
	if !ok {
		return
	}
	name := c.Query("name")
	if name == "" {
		c.JSON(http.StatusBadRequest, gin.H{"error": "missing unit name"})
		return
	}
	lines, _ := strconv.Atoi(c.DefaultQuery("lines", "300"))
	j, err := h.Mgr.JournalTail(c.Request.Context(), claims.UserID, nodeID, name, lines)
	if err != nil {
		respondSystemdErr(c, err)
		return
	}
	c.Header("Cache-Control", "no-store")
	c.JSON(http.StatusOK, j)
}

type systemdActionBody struct {
	Name string `json:"name" binding:"required"`
	Verb string `json:"verb" binding:"required"`
}

func (h *SystemdHandler) Action(c *gin.Context) {
	nodeID, claims, ok := h.ctx(c)
	if !ok {
		return
	}
	var body systemdActionBody
	if err := c.ShouldBindJSON(&body); err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"error": err.Error()})
		return
	}
	if err := h.Mgr.Action(c.Request.Context(), claims.UserID, nodeID, systemd.AuditClaims{
		UserID: claims.UserID, Username: claims.Username, ClientIP: c.ClientIP(),
	}, body.Name, systemd.Verb(body.Verb)); err != nil {
		respondSystemdErr(c, err)
		return
	}
	c.JSON(http.StatusOK, gin.H{"ok": true})
}

func (h *SystemdHandler) ctx(c *gin.Context) (uint64, *auth.Claims, bool) {
	if h == nil || h.Mgr == nil {
		msg := "systemd subsystem unavailable"
		if h != nil && h.unavailableReason != "" {
			msg = h.unavailableReason
		}
		c.JSON(http.StatusServiceUnavailable, gin.H{"error": msg, "code": "subsystem_unavailable"})
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

// respondSystemdErr maps typed errors → HTTP statuses with a machine code so
// the frontend can render contextual hints.
func respondSystemdErr(c *gin.Context, err error) {
	switch {
	case errors.Is(err, systemd.ErrUnauthorized):
		c.JSON(http.StatusForbidden, gin.H{"error": err.Error(), "code": "unauthorized"})
	case errors.Is(err, systemd.ErrDisabled):
		c.JSON(http.StatusServiceUnavailable, gin.H{"error": err.Error(), "code": "disabled"})
	case errors.Is(err, systemd.ErrNoSystemd):
		c.JSON(http.StatusNotImplemented, gin.H{"error": err.Error(), "code": "no_systemd"})
	case errors.Is(err, systemd.ErrPermissionDenied):
		c.JSON(http.StatusForbidden, gin.H{"error": err.Error(), "code": "permission_denied"})
	case errors.Is(err, systemd.ErrUnreachable):
		c.JSON(http.StatusBadGateway, gin.H{"error": err.Error(), "code": "unreachable"})
	case errors.Is(err, systemd.ErrBadUnit):
		c.JSON(http.StatusBadRequest, gin.H{"error": err.Error(), "code": "bad_unit"})
	case errors.Is(err, systemd.ErrBadVerb):
		c.JSON(http.StatusBadRequest, gin.H{"error": err.Error(), "code": "bad_verb"})
	case errors.Is(err, systemd.ErrParse):
		c.JSON(http.StatusBadGateway, gin.H{"error": err.Error(), "code": "parse_error"})
	default:
		c.JSON(http.StatusBadGateway, gin.H{"error": err.Error()})
	}
}
