package api

import (
	"net/http"
	"strconv"

	"github.com/gin-gonic/gin"
	"github.com/michongs/jumpserver-anonymous/internal/model"
	"github.com/michongs/jumpserver-anonymous/internal/repo"
)

type ProxyHandler struct{ Repo *repo.ProxyRepo }

func (h *ProxyHandler) List(c *gin.Context) {
	out, err := h.Repo.List(c.Request.Context())
	if err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": err.Error()})
		return
	}
	c.JSON(http.StatusOK, gin.H{"proxies": out})
}

func (h *ProxyHandler) Create(c *gin.Context) {
	var p model.Proxy
	if err := c.ShouldBindJSON(&p); err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"error": err.Error()})
		return
	}
	if err := h.Repo.Create(c.Request.Context(), &p); err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": err.Error()})
		return
	}
	c.JSON(http.StatusCreated, p)
}

func (h *ProxyHandler) Update(c *gin.Context) {
	id, _ := strconv.ParseUint(c.Param("id"), 10, 64)
	p, err := h.Repo.FindByID(c.Request.Context(), id)
	if err != nil || p == nil {
		c.JSON(http.StatusNotFound, gin.H{"error": "not found"})
		return
	}
	if err := c.ShouldBindJSON(p); err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"error": err.Error()})
		return
	}
	p.ID = id
	if err := h.Repo.Update(c.Request.Context(), p); err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": err.Error()})
		return
	}
	c.JSON(http.StatusOK, p)
}

func (h *ProxyHandler) Delete(c *gin.Context) {
	id, _ := strconv.ParseUint(c.Param("id"), 10, 64)
	if err := h.Repo.Delete(c.Request.Context(), id); err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": err.Error()})
		return
	}
	c.JSON(http.StatusOK, gin.H{"ok": true})
}
