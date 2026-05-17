package api

import (
	"net/http"
	"strconv"

	"github.com/gin-gonic/gin"
	"github.com/michongs/jumpserver-anonymous/internal/model"
	"github.com/michongs/jumpserver-anonymous/internal/repo"
)

type NodeHandler struct{ Repo *repo.NodeRepo }

func (h *NodeHandler) List(c *gin.Context) {
	nodes, err := h.Repo.List(c.Request.Context())
	if err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": err.Error()})
		return
	}
	c.JSON(http.StatusOK, gin.H{"nodes": nodes})
}

func (h *NodeHandler) Get(c *gin.Context) {
	id, _ := strconv.ParseUint(c.Param("id"), 10, 64)
	n, err := h.Repo.FindByID(c.Request.Context(), id)
	if err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": err.Error()})
		return
	}
	if n == nil {
		c.JSON(http.StatusNotFound, gin.H{"error": "not found"})
		return
	}
	c.JSON(http.StatusOK, n)
}

func (h *NodeHandler) Create(c *gin.Context) {
	var n model.Node
	if err := c.ShouldBindJSON(&n); err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"error": err.Error()})
		return
	}
	if err := h.Repo.Create(c.Request.Context(), &n); err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": err.Error()})
		return
	}
	c.JSON(http.StatusCreated, n)
}

func (h *NodeHandler) Update(c *gin.Context) {
	id, _ := strconv.ParseUint(c.Param("id"), 10, 64)
	n, err := h.Repo.FindByID(c.Request.Context(), id)
	if err != nil || n == nil {
		c.JSON(http.StatusNotFound, gin.H{"error": "not found"})
		return
	}
	if err := c.ShouldBindJSON(n); err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"error": err.Error()})
		return
	}
	n.ID = id
	if err := h.Repo.Update(c.Request.Context(), n); err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": err.Error()})
		return
	}
	c.JSON(http.StatusOK, n)
}

func (h *NodeHandler) Delete(c *gin.Context) {
	id, _ := strconv.ParseUint(c.Param("id"), 10, 64)
	if err := h.Repo.Delete(c.Request.Context(), id); err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": err.Error()})
		return
	}
	c.JSON(http.StatusOK, gin.H{"ok": true})
}
