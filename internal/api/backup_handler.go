package api

import (
	"errors"
	"net/http"
	"strconv"

	"github.com/gin-gonic/gin"
	"github.com/michongs/jumpserver-anonymous/internal/auth"
	"github.com/michongs/jumpserver-anonymous/internal/backup"
)

// BackupHandler exposes backup snapshots + `at` job orchestration. Info reads
// require ActionConnect; Snapshot/AddAt/RemoveAt are gated by PermStorageManage
// at the route.
type BackupHandler struct {
	Mgr               *backup.Manager
	unavailableReason string
}

func NewBackupHandler(mgr *backup.Manager) *BackupHandler { return &BackupHandler{Mgr: mgr} }
func NewBackupHandlerStub(reason string) *BackupHandler   { return &BackupHandler{unavailableReason: reason} }

func (h *BackupHandler) Info(c *gin.Context) {
	nodeID, claims, ok := h.ctx(c)
	if !ok {
		return
	}
	info, err := h.Mgr.Info(c.Request.Context(), claims.UserID, nodeID)
	if err != nil {
		respondBackupErr(c, err)
		return
	}
	c.Header("Cache-Control", "no-store")
	c.JSON(http.StatusOK, info)
}

type backupSnapshotBody struct {
	Method string `json:"method" binding:"required"`
	Src    string `json:"src" binding:"required"`
	Dest   string `json:"dest" binding:"required"`
}

func (h *BackupHandler) Snapshot(c *gin.Context) {
	nodeID, claims, ok := h.ctx(c)
	if !ok {
		return
	}
	var body backupSnapshotBody
	if err := c.ShouldBindJSON(&body); err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"error": err.Error()})
		return
	}
	r, err := h.Mgr.Snapshot(c.Request.Context(), claims.UserID, nodeID, backup.AuditClaims{
		UserID: claims.UserID, Username: claims.Username, ClientIP: c.ClientIP(),
	}, body.Method, body.Src, body.Dest)
	if err != nil {
		respondBackupErr(c, err)
		return
	}
	c.JSON(http.StatusOK, r)
}

type backupAtBody struct {
	When    string `json:"when" binding:"required"`
	Command string `json:"command" binding:"required"`
}

func (h *BackupHandler) AddAt(c *gin.Context) {
	nodeID, claims, ok := h.ctx(c)
	if !ok {
		return
	}
	var body backupAtBody
	if err := c.ShouldBindJSON(&body); err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"error": err.Error()})
		return
	}
	if err := h.Mgr.AddAt(c.Request.Context(), claims.UserID, nodeID, backup.AuditClaims{
		UserID: claims.UserID, Username: claims.Username, ClientIP: c.ClientIP(),
	}, body.When, body.Command); err != nil {
		respondBackupErr(c, err)
		return
	}
	c.JSON(http.StatusOK, gin.H{"ok": true})
}

type backupAtRemoveBody struct {
	ID string `json:"id" binding:"required"`
}

func (h *BackupHandler) RemoveAt(c *gin.Context) {
	nodeID, claims, ok := h.ctx(c)
	if !ok {
		return
	}
	var body backupAtRemoveBody
	if err := c.ShouldBindJSON(&body); err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"error": err.Error()})
		return
	}
	if err := h.Mgr.RemoveAt(c.Request.Context(), claims.UserID, nodeID, backup.AuditClaims{
		UserID: claims.UserID, Username: claims.Username, ClientIP: c.ClientIP(),
	}, body.ID); err != nil {
		respondBackupErr(c, err)
		return
	}
	c.JSON(http.StatusOK, gin.H{"ok": true})
}

func (h *BackupHandler) ctx(c *gin.Context) (uint64, *auth.Claims, bool) {
	if h == nil || h.Mgr == nil {
		msg := "backup subsystem unavailable"
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

func respondBackupErr(c *gin.Context, err error) {
	switch {
	case errors.Is(err, backup.ErrUnauthorized):
		c.JSON(http.StatusForbidden, gin.H{"error": err.Error(), "code": "unauthorized"})
	case errors.Is(err, backup.ErrDisabled):
		c.JSON(http.StatusServiceUnavailable, gin.H{"error": err.Error(), "code": "disabled"})
	case errors.Is(err, backup.ErrPermissionDenied):
		c.JSON(http.StatusForbidden, gin.H{"error": err.Error(), "code": "permission_denied"})
	case errors.Is(err, backup.ErrUnreachable):
		c.JSON(http.StatusBadGateway, gin.H{"error": err.Error(), "code": "unreachable"})
	case errors.Is(err, backup.ErrBadArg):
		c.JSON(http.StatusBadRequest, gin.H{"error": err.Error(), "code": "bad_request"})
	default:
		c.JSON(http.StatusBadGateway, gin.H{"error": err.Error()})
	}
}
