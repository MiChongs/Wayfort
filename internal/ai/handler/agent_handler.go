package handler

import (
	"encoding/json"
	"net/http"
	"strconv"

	"github.com/gin-gonic/gin"
	aimodel "github.com/michongs/jumpserver-anonymous/internal/ai/model"
	airepo "github.com/michongs/jumpserver-anonymous/internal/ai/repo"
	"github.com/michongs/jumpserver-anonymous/internal/ai/tools"
	"github.com/michongs/jumpserver-anonymous/internal/auth"
)

type AgentHandler struct {
	Repo  *airepo.AgentRepo
	Tools *tools.Registry
}

type agentPayload struct {
	Name              string   `json:"name"`
	Description       string   `json:"description"`
	Icon              string   `json:"icon"`
	Scope             string   `json:"scope"`
	SystemPrompt      string   `json:"system_prompt"`
	DefaultProviderID *uint64  `json:"default_provider_id"`
	DefaultModel      string   `json:"default_model"`
	AllowedTools      []string `json:"allowed_tools"`
	PermissionMode    string   `json:"permission_mode"`
	MaxIterations     int      `json:"max_iterations"`
	Temperature       float64  `json:"temperature"`
	TopP              float64  `json:"top_p"`
	ContextStrategy   string   `json:"context_strategy"`
	IsSubAgent        bool     `json:"is_sub_agent"`
	InvocationHint    string   `json:"invocation_hint"`
	Tags              []string `json:"tags"`
	Enabled           *bool    `json:"enabled"`
}

func (h *AgentHandler) List(c *gin.Context) {
	claims := auth.FromContext(c.Request.Context())
	rows, err := h.Repo.VisibleTo(c.Request.Context(), claims.UserID)
	if err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": err.Error()})
		return
	}
	c.JSON(http.StatusOK, gin.H{"agents": rows})
}

func (h *AgentHandler) Create(c *gin.Context) {
	claims := auth.FromContext(c.Request.Context())
	var p agentPayload
	if err := c.ShouldBindJSON(&p); err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"error": err.Error()})
		return
	}
	row, err := h.payload(&p, nil, claims)
	if err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"error": err.Error()})
		return
	}
	if err := h.Repo.Create(c.Request.Context(), row); err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": err.Error()})
		return
	}
	c.JSON(http.StatusCreated, gin.H{"id": row.ID})
}

func (h *AgentHandler) Update(c *gin.Context) {
	claims := auth.FromContext(c.Request.Context())
	id, _ := strconv.ParseUint(c.Param("id"), 10, 64)
	row, err := h.Repo.FindByID(c.Request.Context(), id)
	if err != nil || row == nil {
		c.JSON(http.StatusNotFound, gin.H{"error": "not found"})
		return
	}
	if !agentManageable(row, claims) {
		c.JSON(http.StatusForbidden, gin.H{"error": "not your agent"})
		return
	}
	var p agentPayload
	if err := c.ShouldBindJSON(&p); err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"error": err.Error()})
		return
	}
	row, err = h.payload(&p, row, claims)
	if err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"error": err.Error()})
		return
	}
	if err := h.Repo.Update(c.Request.Context(), row); err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": err.Error()})
		return
	}
	c.JSON(http.StatusOK, gin.H{"id": row.ID})
}

func (h *AgentHandler) Delete(c *gin.Context) {
	claims := auth.FromContext(c.Request.Context())
	id, _ := strconv.ParseUint(c.Param("id"), 10, 64)
	row, err := h.Repo.FindByID(c.Request.Context(), id)
	if err != nil || row == nil {
		c.JSON(http.StatusNotFound, gin.H{"error": "not found"})
		return
	}
	if !agentManageable(row, claims) {
		c.JSON(http.StatusForbidden, gin.H{"error": "not your agent"})
		return
	}
	if err := h.Repo.Delete(c.Request.Context(), id); err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": err.Error()})
		return
	}
	c.JSON(http.StatusOK, gin.H{"ok": true})
}

// Catalogue lists the tools available to attach to a new agent.
func (h *AgentHandler) Catalogue(c *gin.Context) {
	c.JSON(http.StatusOK, gin.H{"tools": h.Tools.Catalogue()})
}

func (h *AgentHandler) payload(p *agentPayload, base *aimodel.AIAgent, claims *auth.Claims) (*aimodel.AIAgent, error) {
	row := base
	if row == nil {
		row = &aimodel.AIAgent{}
	}
	if p.Name != "" {
		row.Name = p.Name
	}
	row.Description = p.Description
	row.Icon = p.Icon
	row.SystemPrompt = p.SystemPrompt
	row.DefaultProviderID = p.DefaultProviderID
	row.DefaultModel = p.DefaultModel
	if len(p.AllowedTools) > 0 {
		b, _ := json.Marshal(p.AllowedTools)
		row.AllowedTools = string(b)
	}
	if p.PermissionMode != "" {
		row.PermissionMode = aimodel.PermissionMode(p.PermissionMode)
	} else if base == nil {
		row.PermissionMode = aimodel.PermModeNormal
	}
	if p.MaxIterations > 0 {
		row.MaxIterations = p.MaxIterations
	}
	if p.Temperature > 0 {
		row.Temperature = p.Temperature
	}
	if p.TopP > 0 {
		row.TopP = p.TopP
	}
	if p.ContextStrategy != "" {
		row.ContextStrategy = aimodel.ContextStrategy(p.ContextStrategy)
	}
	row.IsSubAgent = p.IsSubAgent
	row.InvocationHint = p.InvocationHint
	if len(p.Tags) > 0 {
		b, _ := json.Marshal(p.Tags)
		row.Tags = string(b)
	}
	if p.Enabled != nil {
		row.Enabled = *p.Enabled
	} else if base == nil {
		row.Enabled = true
	}
	if p.Scope == "global" && claims.Admin {
		row.Scope = aimodel.AgentScopeGlobal
		row.OwnerID = nil
	} else {
		row.Scope = aimodel.AgentScopePersonal
		uid := claims.UserID
		row.OwnerID = &uid
	}
	return row, nil
}

func agentManageable(row *aimodel.AIAgent, claims *auth.Claims) bool {
	if claims.Admin {
		return true
	}
	return row.Scope == aimodel.AgentScopePersonal && row.OwnerID != nil && *row.OwnerID == claims.UserID
}
