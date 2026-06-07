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

func (h *DockerHandler) Inspect(c *gin.Context) {
	nodeID, claims, ok := h.ctx(c)
	if !ok {
		return
	}
	d, err := h.Mgr.Inspect(c.Request.Context(), claims.UserID, nodeID, c.Param("cid"))
	if err != nil {
		respondDockerErr(c, err)
		return
	}
	c.Header("Cache-Control", "no-store")
	c.JSON(http.StatusOK, d)
}

func (h *DockerHandler) Stats(c *gin.Context) {
	nodeID, claims, ok := h.ctx(c)
	if !ok {
		return
	}
	out, err := h.Mgr.Stats(c.Request.Context(), claims.UserID, nodeID)
	if err != nil {
		respondDockerErr(c, err)
		return
	}
	c.Header("Cache-Control", "no-store")
	c.JSON(http.StatusOK, gin.H{"stats": out})
}

func (h *DockerHandler) Top(c *gin.Context) {
	nodeID, claims, ok := h.ctx(c)
	if !ok {
		return
	}
	t, err := h.Mgr.Top(c.Request.Context(), claims.UserID, nodeID, c.Param("cid"))
	if err != nil {
		respondDockerErr(c, err)
		return
	}
	c.Header("Cache-Control", "no-store")
	c.JSON(http.StatusOK, t)
}

func (h *DockerHandler) Networks(c *gin.Context) {
	nodeID, claims, ok := h.ctx(c)
	if !ok {
		return
	}
	out, err := h.Mgr.Networks(c.Request.Context(), claims.UserID, nodeID)
	if err != nil {
		respondDockerErr(c, err)
		return
	}
	c.JSON(http.StatusOK, gin.H{"networks": out})
}

func (h *DockerHandler) Volumes(c *gin.Context) {
	nodeID, claims, ok := h.ctx(c)
	if !ok {
		return
	}
	out, err := h.Mgr.Volumes(c.Request.Context(), claims.UserID, nodeID)
	if err != nil {
		respondDockerErr(c, err)
		return
	}
	c.JSON(http.StatusOK, gin.H{"volumes": out})
}

func (h *DockerHandler) Rename(c *gin.Context) {
	nodeID, claims, ok := h.ctx(c)
	if !ok {
		return
	}
	var body struct {
		Name string `json:"name" binding:"required"`
	}
	if err := c.ShouldBindJSON(&body); err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"error": err.Error()})
		return
	}
	if err := h.Mgr.Rename(c.Request.Context(), claims.UserID, nodeID, h.ac(c, claims), c.Param("cid"), body.Name); err != nil {
		respondDockerErr(c, err)
		return
	}
	c.JSON(http.StatusOK, gin.H{"ok": true})
}

func (h *DockerHandler) PullImage(c *gin.Context) {
	nodeID, claims, ok := h.ctx(c)
	if !ok {
		return
	}
	var body struct {
		Ref string `json:"ref" binding:"required"`
	}
	if err := c.ShouldBindJSON(&body); err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"error": err.Error()})
		return
	}
	r, err := h.Mgr.PullImage(c.Request.Context(), claims.UserID, nodeID, h.ac(c, claims), body.Ref)
	if err != nil {
		respondDockerErr(c, err)
		return
	}
	c.JSON(http.StatusOK, r)
}

func (h *DockerHandler) RemoveImage(c *gin.Context) {
	nodeID, claims, ok := h.ctx(c)
	if !ok {
		return
	}
	var body struct {
		Ref   string `json:"ref" binding:"required"`
		Force bool   `json:"force"`
	}
	if err := c.ShouldBindJSON(&body); err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"error": err.Error()})
		return
	}
	r, err := h.Mgr.RemoveImage(c.Request.Context(), claims.UserID, nodeID, h.ac(c, claims), body.Ref, body.Force)
	if err != nil {
		respondDockerErr(c, err)
		return
	}
	c.JSON(http.StatusOK, r)
}

func (h *DockerHandler) Prune(c *gin.Context) {
	nodeID, claims, ok := h.ctx(c)
	if !ok {
		return
	}
	var body struct {
		What string `json:"what" binding:"required"`
	}
	if err := c.ShouldBindJSON(&body); err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"error": err.Error()})
		return
	}
	r, err := h.Mgr.Prune(c.Request.Context(), claims.UserID, nodeID, h.ac(c, claims), body.What)
	if err != nil {
		respondDockerErr(c, err)
		return
	}
	c.JSON(http.StatusOK, r)
}

func (h *DockerHandler) ac(c *gin.Context, claims *auth.Claims) docker.AuditClaims {
	return docker.AuditClaims{UserID: claims.UserID, Username: claims.Username, ClientIP: c.ClientIP()}
}

func (h *DockerHandler) Start(c *gin.Context)   { h.do(c, docker.ActionStart) }
func (h *DockerHandler) Stop(c *gin.Context)    { h.do(c, docker.ActionStop) }
func (h *DockerHandler) Restart(c *gin.Context) { h.do(c, docker.ActionRestart) }
func (h *DockerHandler) Remove(c *gin.Context)  { h.do(c, docker.ActionRemove) }
func (h *DockerHandler) Pause(c *gin.Context)   { h.do(c, docker.ActionPause) }
func (h *DockerHandler) Unpause(c *gin.Context) { h.do(c, docker.ActionUnpause) }
func (h *DockerHandler) Kill(c *gin.Context)    { h.do(c, docker.ActionKill) }

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
	case errors.Is(err, docker.ErrInvalidID), errors.Is(err, docker.ErrInvalidRef), errors.Is(err, docker.ErrInvalidArg):
		c.JSON(http.StatusBadRequest, gin.H{"error": err.Error()})
	default:
		c.JSON(http.StatusBadGateway, gin.H{"error": err.Error()})
	}
}
