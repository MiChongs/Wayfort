package api

import (
	"errors"
	"net/http"
	"strconv"

	"github.com/gin-gonic/gin"
	"github.com/michongs/jumpserver-anonymous/internal/auth"
	"github.com/michongs/jumpserver-anonymous/internal/capture"
)

// CaptureHandler exposes bounded packet capture. Interfaces requires
// ActionConnect; Capture/Pcap (which run tcpdump) are gated by PermNetworkManage
// at the route — packet sniffing is privileged.
type CaptureHandler struct {
	Mgr               *capture.Manager
	unavailableReason string
}

func NewCaptureHandler(mgr *capture.Manager) *CaptureHandler { return &CaptureHandler{Mgr: mgr} }
func NewCaptureHandlerStub(reason string) *CaptureHandler    { return &CaptureHandler{unavailableReason: reason} }

func (h *CaptureHandler) Interfaces(c *gin.Context) {
	nodeID, claims, ok := h.ctx(c)
	if !ok {
		return
	}
	out, err := h.Mgr.Interfaces(c.Request.Context(), claims.UserID, nodeID)
	if err != nil {
		respondCaptureErr(c, err)
		return
	}
	c.Header("Cache-Control", "no-store")
	c.JSON(http.StatusOK, out)
}

type captureBody struct {
	Iface   string `json:"iface" binding:"required"`
	Filter  string `json:"filter"`
	Count   int    `json:"count"`
	Seconds int    `json:"seconds"`
}

func (h *CaptureHandler) Capture(c *gin.Context) {
	nodeID, claims, ok := h.ctx(c)
	if !ok {
		return
	}
	var body captureBody
	if err := c.ShouldBindJSON(&body); err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"error": err.Error()})
		return
	}
	r, err := h.Mgr.Capture(c.Request.Context(), claims.UserID, nodeID, captureClaims(c, claims), capture.Opts{
		Iface: body.Iface, Filter: body.Filter, Count: body.Count, Seconds: body.Seconds,
	})
	if err != nil {
		respondCaptureErr(c, err)
		return
	}
	c.JSON(http.StatusOK, r)
}

func (h *CaptureHandler) Pcap(c *gin.Context) {
	nodeID, claims, ok := h.ctx(c)
	if !ok {
		return
	}
	var body captureBody
	if err := c.ShouldBindJSON(&body); err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"error": err.Error()})
		return
	}
	r, err := h.Mgr.Pcap(c.Request.Context(), claims.UserID, nodeID, captureClaims(c, claims), capture.Opts{
		Iface: body.Iface, Filter: body.Filter, Count: body.Count, Seconds: body.Seconds,
	})
	if err != nil {
		respondCaptureErr(c, err)
		return
	}
	c.JSON(http.StatusOK, r)
}

func captureClaims(c *gin.Context, claims *auth.Claims) capture.AuditClaims {
	return capture.AuditClaims{UserID: claims.UserID, Username: claims.Username, ClientIP: c.ClientIP()}
}

func (h *CaptureHandler) ctx(c *gin.Context) (uint64, *auth.Claims, bool) {
	if h == nil || h.Mgr == nil {
		msg := "capture subsystem unavailable"
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

func respondCaptureErr(c *gin.Context, err error) {
	switch {
	case errors.Is(err, capture.ErrUnauthorized):
		c.JSON(http.StatusForbidden, gin.H{"error": err.Error(), "code": "unauthorized"})
	case errors.Is(err, capture.ErrDisabled):
		c.JSON(http.StatusServiceUnavailable, gin.H{"error": err.Error(), "code": "disabled"})
	case errors.Is(err, capture.ErrPermissionDenied):
		c.JSON(http.StatusForbidden, gin.H{"error": err.Error(), "code": "permission_denied"})
	case errors.Is(err, capture.ErrUnreachable):
		c.JSON(http.StatusBadGateway, gin.H{"error": err.Error(), "code": "unreachable"})
	case errors.Is(err, capture.ErrBadArg):
		c.JSON(http.StatusBadRequest, gin.H{"error": err.Error(), "code": "bad_request"})
	default:
		c.JSON(http.StatusBadGateway, gin.H{"error": err.Error()})
	}
}
