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
	Name              string          `json:"name"`
	Description       string          `json:"description"`
	Icon              string          `json:"icon"`
	Scope             string          `json:"scope"`
	SystemPrompt      string          `json:"system_prompt"`
	DefaultProviderID *uint64         `json:"default_provider_id"`
	DefaultModel      string          `json:"default_model"`
	// AllowedTools / KnowledgeBaseIDs / Tags are accepted as EITHER a JSON array
	// or a JSON-stringified array (the web client sends the latter via
	// JSON.stringify). flexStringList / flexUint64List normalise both.
	AllowedTools     json.RawMessage `json:"allowed_tools"`
	PermissionMode   string          `json:"permission_mode"`
	MaxIterations    int             `json:"max_iterations"`
	Temperature      float64         `json:"temperature"`
	TopP             float64         `json:"top_p"`
	ContextStrategy  string          `json:"context_strategy"`
	IsSubAgent       bool            `json:"is_sub_agent"`
	InvocationHint   string          `json:"invocation_hint"`
	Tags             json.RawMessage `json:"tags"`
	KnowledgeBaseIDs json.RawMessage `json:"knowledge_base_ids"`
	MemoryEnabled    *bool           `json:"memory_enabled"`
	Enabled          *bool           `json:"enabled"`
}

// flexStringList decodes a string list from either a JSON array (["a","b"]) or a
// JSON-stringified array ("[\"a\",\"b\"]") — the web client sends the latter.
func flexStringList(raw json.RawMessage) ([]string, bool) {
	raw = bytesTrimSpace(raw)
	if len(raw) == 0 {
		return nil, false
	}
	var arr []string
	if json.Unmarshal(raw, &arr) == nil {
		return arr, true
	}
	var s string
	if json.Unmarshal(raw, &s) == nil {
		if s == "" {
			return nil, true
		}
		if json.Unmarshal([]byte(s), &arr) == nil {
			return arr, true
		}
	}
	return nil, false
}

func flexUint64List(raw json.RawMessage) ([]uint64, bool) {
	raw = bytesTrimSpace(raw)
	if len(raw) == 0 {
		return nil, false
	}
	var arr []uint64
	if json.Unmarshal(raw, &arr) == nil {
		return arr, true
	}
	var s string
	if json.Unmarshal(raw, &s) == nil {
		if s == "" {
			return nil, true
		}
		if json.Unmarshal([]byte(s), &arr) == nil {
			return arr, true
		}
	}
	return nil, false
}

func bytesTrimSpace(b []byte) []byte {
	for len(b) > 0 && (b[0] == ' ' || b[0] == '\n' || b[0] == '\t' || b[0] == '\r') {
		b = b[1:]
	}
	for len(b) > 0 {
		c := b[len(b)-1]
		if c == ' ' || c == '\n' || c == '\t' || c == '\r' {
			b = b[:len(b)-1]
			continue
		}
		break
	}
	if string(b) == "null" {
		return nil
	}
	return b
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
	if tools, ok := flexStringList(p.AllowedTools); ok {
		b, _ := json.Marshal(tools)
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
	if tags, ok := flexStringList(p.Tags); ok {
		b, _ := json.Marshal(tags)
		row.Tags = string(b)
	}
	// Knowledge bases are replaced from the payload when present (allow clearing
	// to [] by sending an empty array).
	if kbs, ok := flexUint64List(p.KnowledgeBaseIDs); ok {
		if kbs == nil {
			kbs = []uint64{}
		}
		b, _ := json.Marshal(kbs)
		row.KnowledgeBaseIDs = string(b)
	}
	if p.MemoryEnabled != nil {
		row.MemoryEnabled = *p.MemoryEnabled
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
