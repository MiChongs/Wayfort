package api

import (
	"errors"
	"net/http"
	"strconv"
	"strings"

	"github.com/gin-gonic/gin"
	"github.com/michongs/wayfort/internal/auth"
	"github.com/michongs/wayfort/internal/dialer"
	"github.com/michongs/wayfort/internal/model"
	"github.com/michongs/wayfort/internal/repo"
)

// ChainTemplateHandler manages reusable proxy chain presets so operators can
// stamp the same hop sequence across many nodes without re-typing IDs.
type ChainTemplateHandler struct {
	Repo    *repo.ChainTemplateRepo
	Proxies *repo.ProxyRepo
}

func (h *ChainTemplateHandler) List(c *gin.Context) {
	tpls, err := h.Repo.List(c.Request.Context())
	if err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": err.Error()})
		return
	}
	// Pre-resolve hops for each template so the front-end can render a
	// preview without N round-trips. We swallow per-template errors and
	// surface them via Issues so a single broken template doesn't tank the
	// whole list.
	type resolvedTemplate struct {
		*model.ProxyChainTemplate
		Hops   []*model.Proxy        `json:"hops"`
		Issues []dialer.ChainIssue   `json:"issues"`
	}
	out := make([]resolvedTemplate, 0, len(tpls))
	for i := range tpls {
		t := &tpls[i]
		hops, _ := resolveChain(c.Request.Context(), h.Proxies, t.Chain)
		issues := dialer.ValidateChainShape(hops)
		out = append(out, resolvedTemplate{
			ProxyChainTemplate: t,
			Hops:               hops,
			Issues:             issues,
		})
	}
	c.JSON(http.StatusOK, gin.H{"templates": out})
}

type templateRequest struct {
	Name        string `json:"name"`
	Description string `json:"description"`
	Chain       string `json:"chain"`
	Tags        string `json:"tags"`
}

func (h *ChainTemplateHandler) Create(c *gin.Context) {
	var req templateRequest
	if err := c.ShouldBindJSON(&req); err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"error": err.Error()})
		return
	}
	t := &model.ProxyChainTemplate{
		Name: strings.TrimSpace(req.Name), Description: req.Description,
		Chain: strings.TrimSpace(req.Chain), Tags: req.Tags,
	}
	if err := validateTemplate(t); err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"error": err.Error()})
		return
	}
	if cc := auth.FromContext(c.Request.Context()); cc != nil {
		id := cc.UserID
		t.CreatedBy = &id
	}
	if err := h.Repo.Create(c.Request.Context(), t); err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": err.Error()})
		return
	}
	c.JSON(http.StatusCreated, t)
}

func (h *ChainTemplateHandler) Update(c *gin.Context) {
	id, _ := strconv.ParseUint(c.Param("id"), 10, 64)
	t, err := h.Repo.FindByID(c.Request.Context(), id)
	if err != nil || t == nil {
		c.JSON(http.StatusNotFound, gin.H{"error": "not found"})
		return
	}
	var req templateRequest
	if err := c.ShouldBindJSON(&req); err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"error": err.Error()})
		return
	}
	if v := strings.TrimSpace(req.Name); v != "" {
		t.Name = v
	}
	t.Description = req.Description
	if v := strings.TrimSpace(req.Chain); v != "" {
		t.Chain = v
	}
	t.Tags = req.Tags
	if err := validateTemplate(t); err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"error": err.Error()})
		return
	}
	if err := h.Repo.Update(c.Request.Context(), t); err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": err.Error()})
		return
	}
	c.JSON(http.StatusOK, t)
}

func (h *ChainTemplateHandler) Delete(c *gin.Context) {
	id, _ := strconv.ParseUint(c.Param("id"), 10, 64)
	if err := h.Repo.Delete(c.Request.Context(), id); err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": err.Error()})
		return
	}
	c.JSON(http.StatusOK, gin.H{"ok": true})
}

func validateTemplate(t *model.ProxyChainTemplate) error {
	if t.Name == "" {
		return errors.New("name required")
	}
	if t.Chain == "" {
		return errors.New("chain required")
	}
	return nil
}
