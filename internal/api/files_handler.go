package api

import (
	"errors"
	"net/http"
	"strconv"

	"github.com/gin-gonic/gin"
	"github.com/michongs/wayfort/internal/auth"
	"github.com/michongs/wayfort/internal/files"
)

// FilesHandler exposes the remote file manager + config editor. List/Read
// require ActionConnect; Write/Chmod are gated by PermStorageManage at the route.
type FilesHandler struct {
	Mgr               *files.Manager
	unavailableReason string
}

func NewFilesHandler(mgr *files.Manager) *FilesHandler { return &FilesHandler{Mgr: mgr} }
func NewFilesHandlerStub(reason string) *FilesHandler  { return &FilesHandler{unavailableReason: reason} }

func (h *FilesHandler) List(c *gin.Context) {
	nodeID, claims, ok := h.ctx(c)
	if !ok {
		return
	}
	l, err := h.Mgr.List(c.Request.Context(), claims.UserID, nodeID, c.Query("path"))
	if err != nil {
		respondFilesErr(c, err)
		return
	}
	c.Header("Cache-Control", "no-store")
	c.JSON(http.StatusOK, l)
}

func (h *FilesHandler) Read(c *gin.Context) {
	nodeID, claims, ok := h.ctx(c)
	if !ok {
		return
	}
	fc, err := h.Mgr.Read(c.Request.Context(), claims.UserID, nodeID, c.Query("path"))
	if err != nil {
		respondFilesErr(c, err)
		return
	}
	c.Header("Cache-Control", "no-store")
	c.JSON(http.StatusOK, fc)
}

type filesWriteBody struct {
	Path    string `json:"path" binding:"required"`
	Content string `json:"content"`
}

func (h *FilesHandler) Write(c *gin.Context) {
	nodeID, claims, ok := h.ctx(c)
	if !ok {
		return
	}
	var body filesWriteBody
	if err := c.ShouldBindJSON(&body); err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"error": err.Error()})
		return
	}
	if err := h.Mgr.Write(c.Request.Context(), claims.UserID, nodeID, files.AuditClaims{
		UserID: claims.UserID, Username: claims.Username, ClientIP: c.ClientIP(),
	}, body.Path, body.Content); err != nil {
		respondFilesErr(c, err)
		return
	}
	c.JSON(http.StatusOK, gin.H{"ok": true})
}

type filesChmodBody struct {
	Path string `json:"path" binding:"required"`
	Mode string `json:"mode" binding:"required"`
}

func (h *FilesHandler) Chmod(c *gin.Context) {
	nodeID, claims, ok := h.ctx(c)
	if !ok {
		return
	}
	var body filesChmodBody
	if err := c.ShouldBindJSON(&body); err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"error": err.Error()})
		return
	}
	if err := h.Mgr.Chmod(c.Request.Context(), claims.UserID, nodeID, files.AuditClaims{
		UserID: claims.UserID, Username: claims.Username, ClientIP: c.ClientIP(),
	}, body.Path, body.Mode); err != nil {
		respondFilesErr(c, err)
		return
	}
	c.JSON(http.StatusOK, gin.H{"ok": true})
}

func (h *FilesHandler) ctx(c *gin.Context) (uint64, *auth.Claims, bool) {
	if h == nil || h.Mgr == nil {
		msg := "files subsystem unavailable"
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

func respondFilesErr(c *gin.Context, err error) {
	switch {
	case errors.Is(err, files.ErrUnauthorized):
		c.JSON(http.StatusForbidden, gin.H{"error": err.Error(), "code": "unauthorized"})
	case errors.Is(err, files.ErrDisabled):
		c.JSON(http.StatusServiceUnavailable, gin.H{"error": err.Error(), "code": "disabled"})
	case errors.Is(err, files.ErrPermissionDenied):
		c.JSON(http.StatusForbidden, gin.H{"error": err.Error(), "code": "permission_denied"})
	case errors.Is(err, files.ErrUnreachable):
		c.JSON(http.StatusBadGateway, gin.H{"error": err.Error(), "code": "unreachable"})
	case errors.Is(err, files.ErrNotFound):
		c.JSON(http.StatusNotFound, gin.H{"error": err.Error(), "code": "not_found"})
	case errors.Is(err, files.ErrTooLarge):
		c.JSON(http.StatusRequestEntityTooLarge, gin.H{"error": err.Error(), "code": "too_large"})
	case errors.Is(err, files.ErrBadPath):
		c.JSON(http.StatusBadRequest, gin.H{"error": err.Error(), "code": "bad_request"})
	default:
		c.JSON(http.StatusBadGateway, gin.H{"error": err.Error()})
	}
}
