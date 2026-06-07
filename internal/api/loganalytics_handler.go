package api

import (
	"errors"
	"net/http"
	"strconv"

	"github.com/gin-gonic/gin"
	"github.com/michongs/jumpserver-anonymous/internal/auth"
	"github.com/michongs/jumpserver-anonymous/internal/loganalytics"
)

// LogAnalyticsHandler exposes read-only log search + severity aggregation.
// Requires ActionConnect on the node (no writes).
type LogAnalyticsHandler struct {
	Mgr               *loganalytics.Manager
	unavailableReason string
}

func NewLogAnalyticsHandler(mgr *loganalytics.Manager) *LogAnalyticsHandler {
	return &LogAnalyticsHandler{Mgr: mgr}
}
func NewLogAnalyticsHandlerStub(reason string) *LogAnalyticsHandler {
	return &LogAnalyticsHandler{unavailableReason: reason}
}

type logSearchBody struct {
	Source  string `json:"source"`
	Pattern string `json:"pattern" binding:"required"`
	Path    string `json:"path"`
	Unit    string `json:"unit"`
	Lines   int    `json:"lines"`
}

func (h *LogAnalyticsHandler) Search(c *gin.Context) {
	nodeID, claims, ok := h.ctx(c)
	if !ok {
		return
	}
	var body logSearchBody
	if err := c.ShouldBindJSON(&body); err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"error": err.Error()})
		return
	}
	r, err := h.Mgr.Search(c.Request.Context(), claims.UserID, nodeID, loganalytics.Query{
		Source: body.Source, Pattern: body.Pattern, Path: body.Path, Unit: body.Unit, Lines: body.Lines,
	})
	if err != nil {
		respondLogAnErr(c, err)
		return
	}
	c.Header("Cache-Control", "no-store")
	c.JSON(http.StatusOK, r)
}

func (h *LogAnalyticsHandler) ctx(c *gin.Context) (uint64, *auth.Claims, bool) {
	if h == nil || h.Mgr == nil {
		msg := "loganalytics subsystem unavailable"
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

func respondLogAnErr(c *gin.Context, err error) {
	switch {
	case errors.Is(err, loganalytics.ErrUnauthorized):
		c.JSON(http.StatusForbidden, gin.H{"error": err.Error(), "code": "unauthorized"})
	case errors.Is(err, loganalytics.ErrDisabled):
		c.JSON(http.StatusServiceUnavailable, gin.H{"error": err.Error(), "code": "disabled"})
	case errors.Is(err, loganalytics.ErrUnreachable):
		c.JSON(http.StatusBadGateway, gin.H{"error": err.Error(), "code": "unreachable"})
	case errors.Is(err, loganalytics.ErrBadQuery):
		c.JSON(http.StatusBadRequest, gin.H{"error": err.Error(), "code": "bad_request"})
	default:
		c.JSON(http.StatusBadGateway, gin.H{"error": err.Error()})
	}
}
