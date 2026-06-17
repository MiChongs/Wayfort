package handler

import (
	"net/http"
	"strconv"

	"github.com/gin-gonic/gin"
	airepo "github.com/michongs/wayfort/internal/ai/repo"
	"github.com/michongs/wayfort/internal/auth"
)

// MemoryHandler manages cross-session long-term agent memory. Non-admins only
// see/edit their own memories; admins (PermAIKnowledge) can manage all.
type MemoryHandler struct {
	Repo *airepo.KnowledgeRepo
}

func (h *MemoryHandler) List(c *gin.Context) {
	claims := auth.FromContext(c.Request.Context())
	f := airepo.MemoryFilter{Query: c.Query("q"), Limit: 500}
	if !claims.Admin {
		uid := claims.UserID
		f.UserID = &uid
	} else if v := c.Query("user_id"); v != "" {
		if uid, err := strconv.ParseUint(v, 10, 64); err == nil {
			f.UserID = &uid
		}
	}
	if v := c.Query("agent_id"); v != "" {
		if aid, err := strconv.ParseUint(v, 10, 64); err == nil {
			f.AgentID = &aid
		}
	}
	rows, err := h.Repo.ListMemories(c.Request.Context(), f)
	if err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": err.Error()})
		return
	}
	c.JSON(http.StatusOK, gin.H{"memories": rows})
}

func (h *MemoryHandler) Update(c *gin.Context) {
	claims := auth.FromContext(c.Request.Context())
	id := parseU64(c.Param("mem_id"))
	mem, err := h.Repo.GetMemory(c.Request.Context(), id)
	if err != nil || mem == nil {
		c.JSON(http.StatusNotFound, gin.H{"error": "not found"})
		return
	}
	if !claims.Admin && mem.UserID != claims.UserID {
		c.JSON(http.StatusForbidden, gin.H{"error": "not your memory"})
		return
	}
	var p struct {
		Content string `json:"content"`
	}
	if err := c.ShouldBindJSON(&p); err != nil || p.Content == "" {
		c.JSON(http.StatusBadRequest, gin.H{"error": "content required"})
		return
	}
	if err := h.Repo.UpdateMemory(c.Request.Context(), id, map[string]any{"content": p.Content}); err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": err.Error()})
		return
	}
	c.JSON(http.StatusOK, gin.H{"id": id})
}

func (h *MemoryHandler) Delete(c *gin.Context) {
	claims := auth.FromContext(c.Request.Context())
	id := parseU64(c.Param("mem_id"))
	mem, err := h.Repo.GetMemory(c.Request.Context(), id)
	if err != nil || mem == nil {
		c.JSON(http.StatusNotFound, gin.H{"error": "not found"})
		return
	}
	if !claims.Admin && mem.UserID != claims.UserID {
		c.JSON(http.StatusForbidden, gin.H{"error": "not your memory"})
		return
	}
	if err := h.Repo.DeleteMemory(c.Request.Context(), id); err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": err.Error()})
		return
	}
	c.JSON(http.StatusOK, gin.H{"ok": true})
}
