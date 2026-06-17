package api

import (
	"errors"
	"net/http"
	"strconv"
	"strings"

	"github.com/gin-gonic/gin"
	"github.com/michongs/wayfort/internal/model"
	"github.com/michongs/wayfort/internal/repo"
)

// DomainHandler exposes CRUD for network domains (security-architecture.md §3,
// §13). A domain owns connectivity: direct / proxy chain / reverse-connect
// agent. The built-in default direct domain is undeletable and its kind is
// pinned, so backfilled nodes always have a valid home.
type DomainHandler struct {
	Repo *repo.DomainRepo
}

func NewDomainHandler(r *repo.DomainRepo) *DomainHandler { return &DomainHandler{Repo: r} }

func (h *DomainHandler) List(c *gin.Context) {
	out, err := h.Repo.List(c.Request.Context())
	if err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": err.Error()})
		return
	}
	c.JSON(http.StatusOK, gin.H{
		"domains": out,
		"summary": gin.H{"total": len(out), "kinds": model.AllDomainKinds},
	})
}

// domainInput is the writable surface; IsDefault is never client-settable.
type domainInput struct {
	Name                  string           `json:"name"`
	Kind                  model.DomainKind `json:"kind"`
	Description           string           `json:"description"`
	ProxyChain            string           `json:"proxy_chain"`
	AllowedProtocols      string           `json:"allowed_protocols"`
	MaxConcurrentSessions int              `json:"max_concurrent_sessions"`
}

func validateDomainInput(in *domainInput) error {
	if strings.TrimSpace(in.Name) == "" {
		return errors.New("网域名称不能为空")
	}
	if !in.Kind.Valid() {
		return errors.New("无效的网域类型")
	}
	switch in.Kind {
	case model.DomainProxy:
		if strings.TrimSpace(in.ProxyChain) == "" {
			return errors.New("代理域必须配置代理链")
		}
	case model.DomainDirect, model.DomainAgent:
		// direct needs no chain; agent connectivity is bound via agents (M2),
		// not a proxy chain, so a chain here is meaningless — reject it to keep
		// the model honest.
		if strings.TrimSpace(in.ProxyChain) != "" {
			return errors.New("仅代理域可配置代理链")
		}
	}
	if in.MaxConcurrentSessions < 0 {
		return errors.New("并发上限不能为负")
	}
	return nil
}

func (h *DomainHandler) Create(c *gin.Context) {
	var in domainInput
	if err := c.ShouldBindJSON(&in); err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"error": err.Error()})
		return
	}
	if err := validateDomainInput(&in); err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"error": err.Error()})
		return
	}
	d := &model.Domain{
		Name:                  strings.TrimSpace(in.Name),
		Kind:                  in.Kind,
		Description:           in.Description,
		ProxyChain:            strings.TrimSpace(in.ProxyChain),
		AllowedProtocols:      strings.TrimSpace(in.AllowedProtocols),
		MaxConcurrentSessions: in.MaxConcurrentSessions,
	}
	if err := h.Repo.Create(c.Request.Context(), d); err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": err.Error()})
		return
	}
	c.JSON(http.StatusCreated, d)
}

func (h *DomainHandler) Update(c *gin.Context) {
	id, err := strconv.ParseUint(c.Param("id"), 10, 64)
	if err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"error": "无效的网域 id"})
		return
	}
	existing, err := h.Repo.FindByID(c.Request.Context(), id)
	if err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": err.Error()})
		return
	}
	if existing == nil {
		c.JSON(http.StatusNotFound, gin.H{"error": "网域不存在"})
		return
	}
	var in domainInput
	if err := c.ShouldBindJSON(&in); err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"error": err.Error()})
		return
	}
	// The default domain is pinned to direct kind so its backfill role can never
	// be broken; everything else stays editable (name, description, policy).
	if existing.IsDefault && in.Kind != model.DomainDirect {
		c.JSON(http.StatusBadRequest, gin.H{"error": "默认网域必须保持直连类型"})
		return
	}
	if err := validateDomainInput(&in); err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"error": err.Error()})
		return
	}
	existing.Name = strings.TrimSpace(in.Name)
	existing.Kind = in.Kind
	existing.Description = in.Description
	existing.ProxyChain = strings.TrimSpace(in.ProxyChain)
	existing.AllowedProtocols = strings.TrimSpace(in.AllowedProtocols)
	existing.MaxConcurrentSessions = in.MaxConcurrentSessions
	if err := h.Repo.Update(c.Request.Context(), existing); err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": err.Error()})
		return
	}
	c.JSON(http.StatusOK, existing)
}

func (h *DomainHandler) Delete(c *gin.Context) {
	id, err := strconv.ParseUint(c.Param("id"), 10, 64)
	if err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"error": "无效的网域 id"})
		return
	}
	existing, err := h.Repo.FindByID(c.Request.Context(), id)
	if err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": err.Error()})
		return
	}
	if existing == nil {
		c.JSON(http.StatusNotFound, gin.H{"error": "网域不存在"})
		return
	}
	if existing.IsDefault {
		c.JSON(http.StatusBadRequest, gin.H{"error": "默认网域不可删除"})
		return
	}
	// Refuse to orphan nodes: a non-empty domain must be emptied (reassign its
	// nodes) before removal.
	n, err := h.Repo.CountNodes(c.Request.Context(), id)
	if err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": err.Error()})
		return
	}
	if n > 0 {
		c.JSON(http.StatusConflict, gin.H{"error": "网域下仍有资产，请先迁移后再删除", "node_count": n})
		return
	}
	if err := h.Repo.Delete(c.Request.Context(), id); err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": err.Error()})
		return
	}
	c.Status(http.StatusNoContent)
}
