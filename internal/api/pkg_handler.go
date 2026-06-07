package api

import (
	"errors"
	"net/http"
	"strconv"

	"github.com/gin-gonic/gin"
	"github.com/michongs/jumpserver-anonymous/internal/auth"
	"github.com/michongs/jumpserver-anonymous/internal/pkg"
)

// PkgHandler exposes OS package management. Reads require ActionConnect;
// install/remove/upgrade/update are gated by PermPackageManage at the route.
type PkgHandler struct {
	Mgr               *pkg.Manager
	unavailableReason string
}

func NewPkgHandler(mgr *pkg.Manager) *PkgHandler { return &PkgHandler{Mgr: mgr} }
func NewPkgHandlerStub(reason string) *PkgHandler { return &PkgHandler{unavailableReason: reason} }

func (h *PkgHandler) Status(c *gin.Context) {
	nodeID, claims, ok := h.ctx(c)
	if !ok {
		return
	}
	s, err := h.Mgr.Status(c.Request.Context(), claims.UserID, nodeID)
	if err != nil {
		respondPkgErr(c, err)
		return
	}
	c.Header("Cache-Control", "no-store")
	c.JSON(http.StatusOK, s)
}

func (h *PkgHandler) Upgradable(c *gin.Context) {
	nodeID, claims, ok := h.ctx(c)
	if !ok {
		return
	}
	ups, err := h.Mgr.Upgradable(c.Request.Context(), claims.UserID, nodeID)
	if err != nil {
		respondPkgErr(c, err)
		return
	}
	c.Header("Cache-Control", "no-store")
	c.JSON(http.StatusOK, gin.H{"updates": ups})
}

func (h *PkgHandler) Search(c *gin.Context) {
	nodeID, claims, ok := h.ctx(c)
	if !ok {
		return
	}
	q := c.Query("q")
	if q == "" {
		c.JSON(http.StatusBadRequest, gin.H{"error": "missing q"})
		return
	}
	res, err := h.Mgr.Search(c.Request.Context(), claims.UserID, nodeID, q)
	if err != nil {
		respondPkgErr(c, err)
		return
	}
	c.Header("Cache-Control", "no-store")
	c.JSON(http.StatusOK, gin.H{"packages": res})
}

func (h *PkgHandler) Do(c *gin.Context) {
	nodeID, claims, ok := h.ctx(c)
	if !ok {
		return
	}
	var body struct {
		Verb string `json:"verb" binding:"required"`
		Name string `json:"name"`
	}
	if err := c.ShouldBindJSON(&body); err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"error": err.Error()})
		return
	}
	r, err := h.Mgr.Do(c.Request.Context(), claims.UserID, nodeID, pkg.AuditClaims{
		UserID: claims.UserID, Username: claims.Username, ClientIP: c.ClientIP(),
	}, pkg.Verb(body.Verb), body.Name)
	if err != nil {
		respondPkgErr(c, err)
		return
	}
	c.JSON(http.StatusOK, r)
}

func (h *PkgHandler) ctx(c *gin.Context) (uint64, *auth.Claims, bool) {
	if h == nil || h.Mgr == nil {
		msg := "pkg subsystem unavailable"
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

func respondPkgErr(c *gin.Context, err error) {
	switch {
	case errors.Is(err, pkg.ErrUnauthorized):
		c.JSON(http.StatusForbidden, gin.H{"error": err.Error(), "code": "unauthorized"})
	case errors.Is(err, pkg.ErrDisabled):
		c.JSON(http.StatusServiceUnavailable, gin.H{"error": err.Error(), "code": "disabled"})
	case errors.Is(err, pkg.ErrPermissionDenied):
		c.JSON(http.StatusForbidden, gin.H{"error": err.Error(), "code": "permission_denied"})
	case errors.Is(err, pkg.ErrUnreachable):
		c.JSON(http.StatusBadGateway, gin.H{"error": err.Error(), "code": "unreachable"})
	case errors.Is(err, pkg.ErrNoManager):
		c.JSON(http.StatusNotImplemented, gin.H{"error": err.Error(), "code": "no_manager"})
	case errors.Is(err, pkg.ErrBadName), errors.Is(err, pkg.ErrBadVerb):
		c.JSON(http.StatusBadRequest, gin.H{"error": err.Error(), "code": "bad_request"})
	default:
		c.JSON(http.StatusBadGateway, gin.H{"error": err.Error()})
	}
}
