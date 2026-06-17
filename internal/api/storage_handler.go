package api

import (
	"errors"
	"net/http"
	"strconv"

	"github.com/gin-gonic/gin"
	"github.com/michongs/wayfort/internal/auth"
	"github.com/michongs/wayfort/internal/storage"
)

// StorageHandler exposes storage inspection + mount control. Info requires
// ActionConnect; mount/umount are gated by PermStorageManage at the route.
type StorageHandler struct {
	Mgr               *storage.Manager
	unavailableReason string
}

func NewStorageHandler(mgr *storage.Manager) *StorageHandler { return &StorageHandler{Mgr: mgr} }
func NewStorageHandlerStub(reason string) *StorageHandler    { return &StorageHandler{unavailableReason: reason} }

func (h *StorageHandler) Info(c *gin.Context) {
	nodeID, claims, ok := h.ctx(c)
	if !ok {
		return
	}
	info, err := h.Mgr.Info(c.Request.Context(), claims.UserID, nodeID)
	if err != nil {
		respondStorageErr(c, err)
		return
	}
	c.Header("Cache-Control", "no-store")
	c.JSON(http.StatusOK, info)
}

type storageMountBody struct {
	Target string `json:"target" binding:"required"`
}

func (h *StorageHandler) Mount(c *gin.Context)   { h.mountOp(c, false) }
func (h *StorageHandler) Unmount(c *gin.Context) { h.mountOp(c, true) }

func (h *StorageHandler) mountOp(c *gin.Context, unmount bool) {
	nodeID, claims, ok := h.ctx(c)
	if !ok {
		return
	}
	var body storageMountBody
	if err := c.ShouldBindJSON(&body); err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"error": err.Error()})
		return
	}
	ac := storage.AuditClaims{UserID: claims.UserID, Username: claims.Username, ClientIP: c.ClientIP()}
	var err error
	if unmount {
		err = h.Mgr.Unmount(c.Request.Context(), claims.UserID, nodeID, ac, body.Target)
	} else {
		err = h.Mgr.Mount(c.Request.Context(), claims.UserID, nodeID, ac, body.Target)
	}
	if err != nil {
		respondStorageErr(c, err)
		return
	}
	c.JSON(http.StatusOK, gin.H{"ok": true})
}

func (h *StorageHandler) ctx(c *gin.Context) (uint64, *auth.Claims, bool) {
	if h == nil || h.Mgr == nil {
		msg := "storage subsystem unavailable"
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

func respondStorageErr(c *gin.Context, err error) {
	switch {
	case errors.Is(err, storage.ErrUnauthorized):
		c.JSON(http.StatusForbidden, gin.H{"error": err.Error(), "code": "unauthorized"})
	case errors.Is(err, storage.ErrDisabled):
		c.JSON(http.StatusServiceUnavailable, gin.H{"error": err.Error(), "code": "disabled"})
	case errors.Is(err, storage.ErrPermissionDenied):
		c.JSON(http.StatusForbidden, gin.H{"error": err.Error(), "code": "permission_denied"})
	case errors.Is(err, storage.ErrUnreachable):
		c.JSON(http.StatusBadGateway, gin.H{"error": err.Error(), "code": "unreachable"})
	case errors.Is(err, storage.ErrBadPath):
		c.JSON(http.StatusBadRequest, gin.H{"error": err.Error(), "code": "bad_path"})
	case errors.Is(err, storage.ErrBusy):
		c.JSON(http.StatusConflict, gin.H{"error": err.Error(), "code": "busy"})
	default:
		c.JSON(http.StatusBadGateway, gin.H{"error": err.Error()})
	}
}
