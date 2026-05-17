// Package handler hosts the HTTP endpoints for the AI subsystem.
package handler

import (
	"net/http"
	"strconv"

	"github.com/gin-gonic/gin"
	aimodel "github.com/michongs/jumpserver-anonymous/internal/ai/model"
	"github.com/michongs/jumpserver-anonymous/internal/ai/provider"
	airepo "github.com/michongs/jumpserver-anonymous/internal/ai/repo"
	"github.com/michongs/jumpserver-anonymous/internal/auth"
	pkgcrypto "github.com/michongs/jumpserver-anonymous/pkg/crypto"
)

type ProviderHandler struct {
	Repo     *airepo.ProviderRepo
	Sealer   *pkgcrypto.Sealer
	Registry *provider.Registry
}

type providerPayload struct {
	Name         string   `json:"name"`
	Kind         string   `json:"kind"`
	DisplayName  string   `json:"display_name"`
	BaseURL      string   `json:"base_url"`
	APIKey       string   `json:"api_key"`
	DefaultModel string   `json:"default_model"`
	Models       []any    `json:"models"`
	IsGlobal     bool     `json:"is_global"`
	Enabled      *bool    `json:"enabled"`
	ProxyURL     string   `json:"proxy_url"`
	RateRPM      int      `json:"rate_limit_rpm"`
	RateTPM      int      `json:"rate_limit_tpm"`
}

func (h *ProviderHandler) List(c *gin.Context) {
	claims := auth.FromContext(c.Request.Context())
	rows, err := h.Repo.VisibleTo(c.Request.Context(), claims.UserID)
	if err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": err.Error()})
		return
	}
	out := make([]gin.H, 0, len(rows))
	for _, r := range rows {
		out = append(out, gin.H{
			"id": r.ID, "name": r.Name, "kind": r.Kind, "display_name": r.DisplayName,
			"base_url": r.BaseURL, "default_model": r.DefaultModel,
			"is_global": r.IsGlobal, "owner_id": r.OwnerID, "enabled": r.Enabled,
			"api_key_last4": r.APIKeyLast4,
		})
	}
	c.JSON(http.StatusOK, gin.H{"providers": out})
}

func (h *ProviderHandler) Create(c *gin.Context) {
	claims := auth.FromContext(c.Request.Context())
	var p providerPayload
	if err := c.ShouldBindJSON(&p); err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"error": err.Error()})
		return
	}
	row, err := h.payload(c, &p, nil, claims)
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

func (h *ProviderHandler) Update(c *gin.Context) {
	claims := auth.FromContext(c.Request.Context())
	id, _ := strconv.ParseUint(c.Param("id"), 10, 64)
	row, err := h.Repo.FindByID(c.Request.Context(), id)
	if err != nil || row == nil {
		c.JSON(http.StatusNotFound, gin.H{"error": "not found"})
		return
	}
	if !canManage(row, claims) {
		c.JSON(http.StatusForbidden, gin.H{"error": "not your provider"})
		return
	}
	var p providerPayload
	if err := c.ShouldBindJSON(&p); err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"error": err.Error()})
		return
	}
	row, err = h.payload(c, &p, row, claims)
	if err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"error": err.Error()})
		return
	}
	if err := h.Repo.Update(c.Request.Context(), row); err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": err.Error()})
		return
	}
	h.Registry.Invalidate(row.ID)
	c.JSON(http.StatusOK, gin.H{"id": row.ID})
}

func (h *ProviderHandler) Delete(c *gin.Context) {
	claims := auth.FromContext(c.Request.Context())
	id, _ := strconv.ParseUint(c.Param("id"), 10, 64)
	row, err := h.Repo.FindByID(c.Request.Context(), id)
	if err != nil || row == nil {
		c.JSON(http.StatusNotFound, gin.H{"error": "not found"})
		return
	}
	if !canManage(row, claims) {
		c.JSON(http.StatusForbidden, gin.H{"error": "not your provider"})
		return
	}
	if err := h.Repo.Delete(c.Request.Context(), id); err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": err.Error()})
		return
	}
	h.Registry.Invalidate(id)
	c.JSON(http.StatusOK, gin.H{"ok": true})
}

func (h *ProviderHandler) Test(c *gin.Context) {
	claims := auth.FromContext(c.Request.Context())
	id, _ := strconv.ParseUint(c.Param("id"), 10, 64)
	p, _, err := h.Registry.Get(c.Request.Context(), id, claims.UserID)
	if err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"error": err.Error()})
		return
	}
	if err := p.Ping(c.Request.Context()); err != nil {
		c.JSON(http.StatusBadGateway, gin.H{"error": err.Error()})
		return
	}
	c.JSON(http.StatusOK, gin.H{"ok": true})
}

func (h *ProviderHandler) Models(c *gin.Context) {
	claims := auth.FromContext(c.Request.Context())
	id, _ := strconv.ParseUint(c.Param("id"), 10, 64)
	p, _, err := h.Registry.Get(c.Request.Context(), id, claims.UserID)
	if err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"error": err.Error()})
		return
	}
	models, err := p.ListModels(c.Request.Context())
	if err != nil {
		c.JSON(http.StatusBadGateway, gin.H{"error": err.Error()})
		return
	}
	c.JSON(http.StatusOK, gin.H{"models": models})
}

func (h *ProviderHandler) payload(c *gin.Context, p *providerPayload, base *aimodel.AIProvider, claims *auth.Claims) (*aimodel.AIProvider, error) {
	row := base
	if row == nil {
		row = &aimodel.AIProvider{}
	}
	if p.Name != "" {
		row.Name = p.Name
	}
	if p.Kind != "" {
		row.Kind = aimodel.ProviderKind(p.Kind)
	}
	row.DisplayName = p.DisplayName
	row.BaseURL = p.BaseURL
	if p.DefaultModel != "" {
		row.DefaultModel = p.DefaultModel
	}
	if p.APIKey != "" {
		sealed, err := h.Sealer.Seal([]byte(p.APIKey))
		if err != nil {
			return nil, err
		}
		row.APIKeyEncrypted = sealed
		row.APIKeyLast4 = lastN(p.APIKey, 4)
	}
	row.ProxyURL = p.ProxyURL
	row.RateLimitRPM = p.RateRPM
	row.RateLimitTPM = p.RateTPM
	if p.IsGlobal && claims.Admin {
		row.IsGlobal = true
		row.OwnerID = nil
	} else {
		row.IsGlobal = false
		uid := claims.UserID
		row.OwnerID = &uid
	}
	if p.Enabled != nil {
		row.Enabled = *p.Enabled
	} else if base == nil {
		row.Enabled = true
	}
	return row, nil
}

func canManage(row *aimodel.AIProvider, claims *auth.Claims) bool {
	if claims.Admin {
		return true
	}
	return row.OwnerID != nil && *row.OwnerID == claims.UserID
}

func lastN(s string, n int) string {
	if len(s) <= n {
		return s
	}
	return s[len(s)-n:]
}
