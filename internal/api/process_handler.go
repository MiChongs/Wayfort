package api

import (
	"context"
	"errors"
	"net/http"
	"strconv"
	"time"

	"github.com/gin-gonic/gin"
	"github.com/michongs/jumpserver-anonymous/internal/auth"
	"github.com/michongs/jumpserver-anonymous/internal/process"
	"github.com/michongs/jumpserver-anonymous/internal/sse"
)

// ProcessHandler exposes the ops-dock process surface. Reads require
// ActionConnect; signal/renice are gated by PermProcessManage at the route.
type ProcessHandler struct {
	Mgr               *process.Manager
	unavailableReason string
}

func NewProcessHandler(mgr *process.Manager) *ProcessHandler { return &ProcessHandler{Mgr: mgr} }
func NewProcessHandlerStub(reason string) *ProcessHandler {
	return &ProcessHandler{unavailableReason: reason}
}

func (h *ProcessHandler) List(c *gin.Context) {
	nodeID, claims, ok := h.ctx(c)
	if !ok {
		return
	}
	sort := c.DefaultQuery("sort", "cpu")
	list, err := h.Mgr.List(c.Request.Context(), claims.UserID, nodeID, sort)
	if err != nil {
		respondProcessErr(c, err)
		return
	}
	c.Header("Cache-Control", "no-store")
	c.JSON(http.StatusOK, list)
}

// Stream pushes a fresh process list every few seconds over SSE. The remote
// `ps` is re-run server-side over the pooled SSH connection, so the client gets
// pushed updates without per-tick request setup. The first list is fetched
// synchronously to preserve proper HTTP error codes.
func (h *ProcessHandler) Stream(c *gin.Context) {
	nodeID, claims, ok := h.ctx(c)
	if !ok {
		return
	}
	sort := c.DefaultQuery("sort", "cpu")
	produce := func(ctx context.Context) (any, error) {
		return h.Mgr.List(ctx, claims.UserID, nodeID, sort)
	}
	first, err := produce(c.Request.Context())
	if err != nil {
		respondProcessErr(c, err)
		return
	}
	sse.Snapshots(c, 3*time.Second, first, produce)
}

func (h *ProcessHandler) Detail(c *gin.Context) {
	nodeID, claims, ok := h.ctx(c)
	if !ok {
		return
	}
	pid, err := strconv.Atoi(c.Query("pid"))
	if err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"error": "bad pid"})
		return
	}
	d, err := h.Mgr.Detail(c.Request.Context(), claims.UserID, nodeID, pid)
	if err != nil {
		respondProcessErr(c, err)
		return
	}
	c.Header("Cache-Control", "no-store")
	c.JSON(http.StatusOK, d)
}

type processSignalBody struct {
	PID    int    `json:"pid" binding:"required"`
	Signal string `json:"signal" binding:"required"`
}

func (h *ProcessHandler) Signal(c *gin.Context) {
	nodeID, claims, ok := h.ctx(c)
	if !ok {
		return
	}
	var body processSignalBody
	if err := c.ShouldBindJSON(&body); err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"error": err.Error()})
		return
	}
	if err := h.Mgr.Signal(c.Request.Context(), claims.UserID, nodeID, process.AuditClaims{
		UserID: claims.UserID, Username: claims.Username, ClientIP: c.ClientIP(),
	}, body.PID, process.Signal(body.Signal)); err != nil {
		respondProcessErr(c, err)
		return
	}
	c.JSON(http.StatusOK, gin.H{"ok": true})
}

type processReniceBody struct {
	PID  int `json:"pid" binding:"required"`
	Nice int `json:"nice"`
}

func (h *ProcessHandler) Renice(c *gin.Context) {
	nodeID, claims, ok := h.ctx(c)
	if !ok {
		return
	}
	var body processReniceBody
	if err := c.ShouldBindJSON(&body); err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"error": err.Error()})
		return
	}
	if err := h.Mgr.Renice(c.Request.Context(), claims.UserID, nodeID, process.AuditClaims{
		UserID: claims.UserID, Username: claims.Username, ClientIP: c.ClientIP(),
	}, body.PID, body.Nice); err != nil {
		respondProcessErr(c, err)
		return
	}
	c.JSON(http.StatusOK, gin.H{"ok": true})
}

func (h *ProcessHandler) ctx(c *gin.Context) (uint64, *auth.Claims, bool) {
	if h == nil || h.Mgr == nil {
		msg := "process subsystem unavailable"
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

func respondProcessErr(c *gin.Context, err error) {
	switch {
	case errors.Is(err, process.ErrUnauthorized):
		c.JSON(http.StatusForbidden, gin.H{"error": err.Error(), "code": "unauthorized"})
	case errors.Is(err, process.ErrDisabled):
		c.JSON(http.StatusServiceUnavailable, gin.H{"error": err.Error(), "code": "disabled"})
	case errors.Is(err, process.ErrPermissionDenied):
		c.JSON(http.StatusForbidden, gin.H{"error": err.Error(), "code": "permission_denied"})
	case errors.Is(err, process.ErrUnreachable):
		c.JSON(http.StatusBadGateway, gin.H{"error": err.Error(), "code": "unreachable"})
	case errors.Is(err, process.ErrBadPID):
		c.JSON(http.StatusBadRequest, gin.H{"error": err.Error(), "code": "bad_pid"})
	case errors.Is(err, process.ErrBadSignal), errors.Is(err, process.ErrBadNice):
		c.JSON(http.StatusBadRequest, gin.H{"error": err.Error(), "code": "bad_request"})
	case errors.Is(err, process.ErrParse):
		c.JSON(http.StatusBadGateway, gin.H{"error": err.Error(), "code": "parse_error"})
	default:
		c.JSON(http.StatusBadGateway, gin.H{"error": err.Error()})
	}
}
