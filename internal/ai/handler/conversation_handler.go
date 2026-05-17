package handler

import (
	"net/http"

	"github.com/gin-gonic/gin"
	"github.com/google/uuid"
	aimodel "github.com/michongs/jumpserver-anonymous/internal/ai/model"
	airepo "github.com/michongs/jumpserver-anonymous/internal/ai/repo"
	"github.com/michongs/jumpserver-anonymous/internal/ai/runner"
	"github.com/michongs/jumpserver-anonymous/internal/auth"
)

type ConversationHandler struct {
	Repo    *airepo.ConversationRepo
	Msg     *airepo.MessageRepo
	Inv     *airepo.InvocationRepo
	Agents  *airepo.AgentRepo
	Factory *runner.Factory
}

type createConvReq struct {
	AgentID        uint64  `json:"agent_id" binding:"required"`
	ProviderID     *uint64 `json:"provider_id"`
	Model          string  `json:"model"`
	PermissionMode string  `json:"permission_mode"`
	Title          string  `json:"title"`
}

func (h *ConversationHandler) Create(c *gin.Context) {
	claims := auth.FromContext(c.Request.Context())
	var req createConvReq
	if err := c.ShouldBindJSON(&req); err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"error": err.Error()})
		return
	}
	agent, err := h.Agents.FindByID(c.Request.Context(), req.AgentID)
	if err != nil || agent == nil {
		c.JSON(http.StatusNotFound, gin.H{"error": "agent not found"})
		return
	}
	// Visibility check: personal agents only by owner.
	if agent.Scope == aimodel.AgentScopePersonal && (agent.OwnerID == nil || *agent.OwnerID != claims.UserID) {
		c.JSON(http.StatusForbidden, gin.H{"error": "agent not visible"})
		return
	}
	mode := aimodel.PermissionMode(req.PermissionMode)
	if mode == "" {
		mode = agent.PermissionMode
	}
	conv := &aimodel.AIConversation{
		ID:             "conv_" + uuid.NewString(),
		UserID:         claims.UserID,
		AgentID:        req.AgentID,
		Title:          orStr(req.Title, "新对话"),
		Model:          req.Model,
		PermissionMode: mode,
		Status:         aimodel.ConvStatusActive,
	}
	if req.ProviderID != nil {
		conv.ProviderID = *req.ProviderID
	}
	if err := h.Repo.Create(c.Request.Context(), conv); err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": err.Error()})
		return
	}
	c.JSON(http.StatusCreated, conv)
}

func (h *ConversationHandler) List(c *gin.Context) {
	claims := auth.FromContext(c.Request.Context())
	rows, err := h.Repo.ListByUser(c.Request.Context(), claims.UserID, 100)
	if err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": err.Error()})
		return
	}
	c.JSON(http.StatusOK, gin.H{"conversations": rows})
}

func (h *ConversationHandler) Get(c *gin.Context) {
	conv, ok := h.requireOwn(c)
	if !ok {
		return
	}
	msgs, _ := h.Msg.ListByConv(c.Request.Context(), conv.ID)
	invs, _ := h.Inv.ListByConv(c.Request.Context(), conv.ID)
	c.JSON(http.StatusOK, gin.H{
		"conversation": conv,
		"messages":     msgs,
		"invocations":  invs,
	})
}

type updateConvReq struct {
	Title          string `json:"title"`
	PermissionMode string `json:"permission_mode"`
	Archived       *bool  `json:"archived"`
}

func (h *ConversationHandler) Update(c *gin.Context) {
	conv, ok := h.requireOwn(c)
	if !ok {
		return
	}
	var req updateConvReq
	if err := c.ShouldBindJSON(&req); err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"error": err.Error()})
		return
	}
	if req.Title != "" {
		conv.Title = req.Title
	}
	if req.PermissionMode != "" {
		conv.PermissionMode = aimodel.PermissionMode(req.PermissionMode)
	}
	if req.Archived != nil {
		conv.Archived = *req.Archived
	}
	if err := h.Repo.Update(c.Request.Context(), conv); err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": err.Error()})
		return
	}
	c.JSON(http.StatusOK, conv)
}

func (h *ConversationHandler) Delete(c *gin.Context) {
	conv, ok := h.requireOwn(c)
	if !ok {
		return
	}
	if err := h.Repo.Delete(c.Request.Context(), conv.ID); err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": err.Error()})
		return
	}
	c.JSON(http.StatusOK, gin.H{"ok": true})
}

func (h *ConversationHandler) Cancel(c *gin.Context) {
	conv, ok := h.requireOwn(c)
	if !ok {
		return
	}
	h.Factory.Cancel(conv.ID)
	c.JSON(http.StatusOK, gin.H{"ok": true})
}

func (h *ConversationHandler) requireOwn(c *gin.Context) (*aimodel.AIConversation, bool) {
	claims := auth.FromContext(c.Request.Context())
	id := c.Param("id")
	conv, err := h.Repo.FindByID(c.Request.Context(), id)
	if err != nil || conv == nil {
		c.JSON(http.StatusNotFound, gin.H{"error": "not found"})
		return nil, false
	}
	if conv.UserID != claims.UserID && !claims.Admin {
		c.JSON(http.StatusForbidden, gin.H{"error": "not yours"})
		return nil, false
	}
	return conv, true
}

func orStr(a, b string) string {
	if a != "" {
		return a
	}
	return b
}
