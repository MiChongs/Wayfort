package handler

import (
	"net/http"

	"github.com/gin-gonic/gin"
	airepo "github.com/michongs/jumpserver-anonymous/internal/ai/repo"
	"github.com/michongs/jumpserver-anonymous/internal/ai/runner"
	"github.com/michongs/jumpserver-anonymous/internal/auth"
)

// InvocationHandler implements the approve/reject endpoints used by the
// permission_required SSE event.
type InvocationHandler struct {
	Conv    *airepo.ConversationRepo
	Inv     *airepo.InvocationRepo
	Factory *runner.Factory
}

func (h *InvocationHandler) Approve(c *gin.Context) {
	h.signal(c, true)
}

func (h *InvocationHandler) Reject(c *gin.Context) {
	h.signal(c, false)
}

// Answer delivers a user's reply to a waiting ask_user invocation.
func (h *InvocationHandler) Answer(c *gin.Context) {
	claims := auth.FromContext(c.Request.Context())
	convID := c.Param("id")
	invID := c.Param("inv_id")
	conv, err := h.Conv.FindByID(c.Request.Context(), convID)
	if err != nil || conv == nil {
		c.JSON(http.StatusNotFound, gin.H{"error": "conv not found"})
		return
	}
	if conv.UserID != claims.UserID && !claims.Admin {
		c.JSON(http.StatusForbidden, gin.H{"error": "not yours"})
		return
	}
	var p struct {
		Answer string `json:"answer"`
	}
	if err := c.ShouldBindJSON(&p); err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"error": err.Error()})
		return
	}
	if !h.Factory.Answer(convID, invID, p.Answer) {
		c.JSON(http.StatusGone, gin.H{"error": "question no longer waiting"})
		return
	}
	c.JSON(http.StatusOK, gin.H{"ok": true})
}

func (h *InvocationHandler) signal(c *gin.Context, ok bool) {
	claims := auth.FromContext(c.Request.Context())
	convID := c.Param("id")
	invID := c.Param("inv_id")
	conv, err := h.Conv.FindByID(c.Request.Context(), convID)
	if err != nil || conv == nil {
		c.JSON(http.StatusNotFound, gin.H{"error": "conv not found"})
		return
	}
	if conv.UserID != claims.UserID && !claims.Admin {
		c.JSON(http.StatusForbidden, gin.H{"error": "not yours"})
		return
	}
	var delivered bool
	if ok {
		delivered = h.Factory.Approve(convID, invID)
	} else {
		delivered = h.Factory.Reject(convID, invID)
	}
	if !delivered {
		c.JSON(http.StatusGone, gin.H{"error": "invocation no longer waiting"})
		return
	}
	c.JSON(http.StatusOK, gin.H{"ok": true})
}
