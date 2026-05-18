package api

import (
	"errors"
	"net/http"
	"strconv"

	"github.com/gin-gonic/gin"
	"github.com/michongs/jumpserver-anonymous/internal/auth"
	"github.com/michongs/jumpserver-anonymous/internal/docker"
)

type DockerHandler struct {
	Mgr *docker.Manager
}

func NewDockerHandler(mgr *docker.Manager) *DockerHandler {
	return &DockerHandler{Mgr: mgr}
}

func (h *DockerHandler) Status(c *gin.Context) {
	nodeID, claims, ok := h.ctx(c)
	if !ok {
		return
	}
	s, err := h.Mgr.Status(c.Request.Context(), claims.UserID, nodeID)
	if err != nil {
		respondDockerErr(c, err)
		return
	}
	c.JSON(http.StatusOK, s)
}

func (h *DockerHandler) ListContainers(c *gin.Context) {
	nodeID, claims, ok := h.ctx(c)
	if !ok {
		return
	}
	out, err := h.Mgr.ListContainers(c.Request.Context(), claims.UserID, nodeID)
	if err != nil {
		respondDockerErr(c, err)
		return
	}
	c.JSON(http.StatusOK, gin.H{"containers": out})
}

func (h *DockerHandler) ListImages(c *gin.Context) {
	nodeID, claims, ok := h.ctx(c)
	if !ok {
		return
	}
	out, err := h.Mgr.ListImages(c.Request.Context(), claims.UserID, nodeID)
	if err != nil {
		respondDockerErr(c, err)
		return
	}
	c.JSON(http.StatusOK, gin.H{"images": out})
}

func (h *DockerHandler) Logs(c *gin.Context) {
	nodeID, claims, ok := h.ctx(c)
	if !ok {
		return
	}
	cid := c.Param("cid")
	tail, _ := strconv.Atoi(c.DefaultQuery("tail", "500"))
	out, err := h.Mgr.Logs(c.Request.Context(), claims.UserID, nodeID, cid, tail)
	if err != nil {
		respondDockerErr(c, err)
		return
	}
	c.JSON(http.StatusOK, out)
}

func (h *DockerHandler) Start(c *gin.Context)   { h.do(c, docker.ActionStart) }
func (h *DockerHandler) Stop(c *gin.Context)    { h.do(c, docker.ActionStop) }
func (h *DockerHandler) Restart(c *gin.Context) { h.do(c, docker.ActionRestart) }
func (h *DockerHandler) Remove(c *gin.Context)  { h.do(c, docker.ActionRemove) }

func (h *DockerHandler) do(c *gin.Context, action docker.Action) {
	nodeID, claims, ok := h.ctx(c)
	if !ok {
		return
	}
	cid := c.Param("cid")
	force := c.Query("force") == "true"
	if err := h.Mgr.Do(c.Request.Context(), claims.UserID, nodeID, docker.AuditClaims{
		UserID: claims.UserID, Username: claims.Username, ClientIP: c.ClientIP(),
	}, action, cid, force); err != nil {
		respondDockerErr(c, err)
		return
	}
	c.JSON(http.StatusOK, gin.H{"ok": true})
}

func (h *DockerHandler) ctx(c *gin.Context) (uint64, *auth.Claims, bool) {
	if h == nil || h.Mgr == nil {
		c.JSON(http.StatusServiceUnavailable, gin.H{"error": "docker subsystem unavailable"})
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

func respondDockerErr(c *gin.Context, err error) {
	switch {
	case errors.Is(err, docker.ErrUnauthorized):
		c.JSON(http.StatusForbidden, gin.H{"error": err.Error()})
	case errors.Is(err, docker.ErrDisabled):
		c.JSON(http.StatusServiceUnavailable, gin.H{"error": err.Error()})
	case errors.Is(err, docker.ErrUnavailable):
		c.JSON(http.StatusBadGateway, gin.H{"error": err.Error()})
	case errors.Is(err, docker.ErrInvalidID):
		c.JSON(http.StatusBadRequest, gin.H{"error": err.Error()})
	default:
		c.JSON(http.StatusBadGateway, gin.H{"error": err.Error()})
	}
}
