// Package handler hosts the HTTP endpoints for the AI subsystem.
package handler

import (
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"strconv"
	"strings"
	"time"

	"github.com/gin-gonic/gin"
	"github.com/michongs/jumpserver-anonymous/internal/ai/catalog"
	aihealth "github.com/michongs/jumpserver-anonymous/internal/ai/health"
	aimodel "github.com/michongs/jumpserver-anonymous/internal/ai/model"
	"github.com/michongs/jumpserver-anonymous/internal/ai/provider"
	"github.com/michongs/jumpserver-anonymous/internal/ai/ratelimit"
	airepo "github.com/michongs/jumpserver-anonymous/internal/ai/repo"
	"github.com/michongs/jumpserver-anonymous/internal/auth"
	pkgcrypto "github.com/michongs/jumpserver-anonymous/pkg/crypto"
)

type ProviderHandler struct {
	Repo     *airepo.ProviderRepo
	Sealer   pkgcrypto.Vault
	Registry *provider.Registry
	// Health + Limiter are optional (nil-safe): they enrich List/Test/RateLimit
	// with live reachability + budget when the host wires them.
	Health   *aihealth.Registry
	Limiter  *ratelimit.Limiter
}

type providerPayload struct {
	Name         string          `json:"name"`
	Kind         string          `json:"kind"`
	DisplayName  string          `json:"display_name"`
	BaseURL      string          `json:"base_url"`
	APIKey       string          `json:"api_key"`
	DefaultModel string          `json:"default_model"`
	Models       json.RawMessage `json:"models"`
	Extra        json.RawMessage `json:"extra"`
	IsGlobal     bool            `json:"is_global"`
	Enabled      *bool           `json:"enabled"`
	ProxyURL     string          `json:"proxy_url"`
	RateRPM      int             `json:"rate_limit_rpm"`
	RateTPM      int             `json:"rate_limit_tpm"`
}

func (h *ProviderHandler) List(c *gin.Context) {
	claims := auth.FromContext(c.Request.Context())
	rows, err := h.Repo.VisibleTo(c.Request.Context(), claims.UserID)
	if err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": err.Error()})
		return
	}
	out := make([]gin.H, 0, len(rows))
	for i := range rows {
		out = append(out, h.present(&rows[i]))
	}
	c.JSON(http.StatusOK, gin.H{"providers": out})
}

// present renders one provider row for the API: every configurable field plus
// live health + rate-limit budget, with secrets redacted (api key reduced to its
// last 4; secret-shaped extra fields collapsed to booleans).
func (h *ProviderHandler) present(r *aimodel.AIProvider) gin.H {
	g := gin.H{
		"id": r.ID, "name": r.Name, "kind": r.Kind, "display_name": r.DisplayName,
		"base_url": r.BaseURL, "default_model": r.DefaultModel,
		"is_global": r.IsGlobal, "owner_id": r.OwnerID, "enabled": r.Enabled,
		"api_key_last4":   r.APIKeyLast4,
		"proxy_url":       r.ProxyURL,
		"rate_limit_rpm":  r.RateLimitRPM,
		"rate_limit_tpm":  r.RateLimitTPM,
		"models":          parseModelList(r.Models),
		"extra":           redactExtra(r.ExtraJSON),
		"created_at":      r.CreatedAt,
		"updated_at":      r.UpdatedAt,
	}
	if h.Health != nil {
		if st := h.Health.Get(r.ID); st.ProviderID != 0 || !st.CheckedAt.IsZero() {
			g["health"] = st
		}
	}
	return g
}

// parseModelList unmarshals the curated Models JSON for the API, returning an
// empty slice (not null) so the frontend can always map over it.
func parseModelList(raw string) []provider.ModelInfo {
	out := []provider.ModelInfo{}
	if strings.TrimSpace(raw) == "" {
		return out
	}
	_ = json.Unmarshal([]byte(raw), &out)
	return out
}

// redactExtra returns the provider's extra config with secret-shaped values
// collapsed to booleans, so the plaintext ExtraJSON column never echoes back.
func redactExtra(raw string) gin.H {
	e := provider.ParseExtra(raw)
	g := gin.H{}
	if e.AzureDeployment != "" {
		g["azure_deployment"] = e.AzureDeployment
	}
	if e.AzureAPIVersion != "" {
		g["azure_api_version"] = e.AzureAPIVersion
	}
	if e.AzureEndpoint != "" {
		g["azure_endpoint"] = e.AzureEndpoint
	}
	if e.BedrockRegion != "" {
		g["bedrock_region"] = e.BedrockRegion
	}
	if e.OrgID != "" {
		g["org_id"] = e.OrgID
	}
	if len(e.Headers) > 0 {
		keys := make([]string, 0, len(e.Headers))
		for k := range e.Headers {
			keys = append(keys, k)
		}
		g["header_keys"] = keys // values are potentially secret — expose names only
	}
	return g
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

// Test pings the provider and reports latency + a bounded model probe, so the
// setup wizard can show "online · 234ms · 18 models" rather than a bare ok.
func (h *ProviderHandler) Test(c *gin.Context) {
	claims := auth.FromContext(c.Request.Context())
	id, _ := strconv.ParseUint(c.Param("id"), 10, 64)
	p, _, err := h.Registry.Get(c.Request.Context(), id, claims.UserID)
	if err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"error": err.Error()})
		return
	}
	start := time.Now()
	if err := p.Ping(c.Request.Context()); err != nil {
		c.JSON(http.StatusBadGateway, gin.H{"ok": false, "reachable": false, "error": err.Error()})
		return
	}
	latency := time.Since(start).Milliseconds()
	resp := gin.H{"ok": true, "reachable": true, "latency_ms": latency}
	// Best-effort model probe (bounded); failure doesn't fail the test.
	mctx, cancel := contextWithTimeout(c, 6*time.Second)
	defer cancel()
	if models, err := p.ListModels(mctx); err == nil {
		resp["model_count"] = len(models)
		if len(models) > 0 {
			resp["sample_model"] = models[0].ID
		}
	}
	c.JSON(http.StatusOK, resp)
}

// Models returns the provider's models for the UI. With ?merge=1 it merges live
// discovery with the preset catalog defaults (capabilities + pricing + context)
// and the already-curated list, so the wizard/detail editor can present a
// review-then-save candidate set WITHOUT persisting anything.
func (h *ProviderHandler) Models(c *gin.Context) {
	claims := auth.FromContext(c.Request.Context())
	id, _ := strconv.ParseUint(c.Param("id"), 10, 64)
	p, row, err := h.Registry.Get(c.Request.Context(), id, claims.UserID)
	if err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"error": err.Error()})
		return
	}
	models, err := p.ListModels(c.Request.Context())
	if err != nil && c.Query("merge") != "1" {
		c.JSON(http.StatusBadGateway, gin.H{"error": err.Error()})
		return
	}
	if c.Query("merge") == "1" {
		models = mergeModels(row, models)
	}
	c.JSON(http.StatusOK, gin.H{"models": models})
}

// SaveModels persists the operator-curated model list (capabilities + pricing +
// default) onto the provider row and invalidates the built-client cache so the
// next turn picks up the new metadata.
func (h *ProviderHandler) SaveModels(c *gin.Context) {
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
	var body struct {
		Models       []provider.ModelInfo `json:"models"`
		DefaultModel string               `json:"default_model"`
	}
	if err := c.ShouldBindJSON(&body); err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"error": err.Error()})
		return
	}
	enc, _ := json.Marshal(body.Models)
	row.Models = string(enc)
	if body.DefaultModel != "" {
		row.DefaultModel = body.DefaultModel
	}
	if err := h.Repo.Update(c.Request.Context(), row); err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": err.Error()})
		return
	}
	h.Registry.Invalidate(row.ID)
	c.JSON(http.StatusOK, gin.H{"ok": true})
}

// RateLimit reports the live RPM/TPM budget for one provider (for the Limits gauge).
func (h *ProviderHandler) RateLimit(c *gin.Context) {
	claims := auth.FromContext(c.Request.Context())
	id, _ := strconv.ParseUint(c.Param("id"), 10, 64)
	row, err := h.Repo.FindByID(c.Request.Context(), id)
	if err != nil || row == nil {
		c.JSON(http.StatusNotFound, gin.H{"error": "not found"})
		return
	}
	if !row.IsGlobal && !canManage(row, claims) {
		c.JSON(http.StatusForbidden, gin.H{"error": "not visible"})
		return
	}
	out := gin.H{"rate_limit_rpm": row.RateLimitRPM, "rate_limit_tpm": row.RateLimitTPM}
	if h.Limiter != nil {
		out["remaining"] = h.Limiter.Remaining(id)
	}
	c.JSON(http.StatusOK, out)
}

// draftBody is the wizard's pre-create payload for TestDraft / DiscoverModels.
type draftBody struct {
	Kind     string          `json:"kind"`
	Name     string          `json:"name"`
	BaseURL  string          `json:"base_url"`
	APIKey   string          `json:"api_key"`
	ProxyURL string          `json:"proxy_url"`
	Models   json.RawMessage `json:"models"`
	Extra    json.RawMessage `json:"extra"`
}

func (b *draftBody) build(c *gin.Context) (provider.Provider, error) {
	var models []provider.ModelInfo
	if len(b.Models) > 0 {
		_ = json.Unmarshal(b.Models, &models)
	}
	extra := provider.Extra{}
	if len(b.Extra) > 0 {
		_ = json.Unmarshal(b.Extra, &extra)
	}
	return provider.BuildEphemeral(c.Request.Context(), aimodel.ProviderKind(b.Kind),
		b.Name, b.BaseURL, b.APIKey, b.ProxyURL, "", models, extra)
}

// TestDraft pings an unsaved provider draft (the wizard's "test before commit"),
// returning latency + a bounded model probe.
func (h *ProviderHandler) TestDraft(c *gin.Context) {
	var b draftBody
	if err := c.ShouldBindJSON(&b); err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"error": err.Error()})
		return
	}
	prov, err := b.build(c)
	if err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"ok": false, "error": err.Error()})
		return
	}
	start := time.Now()
	if err := prov.Ping(c.Request.Context()); err != nil {
		c.JSON(http.StatusOK, gin.H{"ok": false, "reachable": false, "error": err.Error()})
		return
	}
	resp := gin.H{"ok": true, "reachable": true, "latency_ms": time.Since(start).Milliseconds()}
	mctx, cancel := contextWithTimeout(c, 6*time.Second)
	defer cancel()
	if models, err := prov.ListModels(mctx); err == nil {
		resp["model_count"] = len(models)
		if len(models) > 0 {
			resp["sample_model"] = models[0].ID
		}
	}
	c.JSON(http.StatusOK, resp)
}

// DiscoverModels lists the live models of an unsaved draft (wizard step 4). The
// frontend merges these with the preset's curated capabilities/pricing.
func (h *ProviderHandler) DiscoverModels(c *gin.Context) {
	var b draftBody
	if err := c.ShouldBindJSON(&b); err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"error": err.Error()})
		return
	}
	prov, err := b.build(c)
	if err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"error": err.Error()})
		return
	}
	models, err := prov.ListModels(c.Request.Context())
	if err != nil {
		c.JSON(http.StatusBadGateway, gin.H{"error": err.Error(), "models": []provider.ModelInfo{}})
		return
	}
	c.JSON(http.StatusOK, gin.H{"models": models})
}

// Presets serves the static provider catalog that drives the "add provider"
// gallery + guided wizard. Optional ?region= filters to one category.
func (h *ProviderHandler) Presets(c *gin.Context) {
	if region := c.Query("region"); region != "" {
		c.JSON(http.StatusOK, gin.H{"presets": catalog.ByRegion(catalog.Region(region))})
		return
	}
	c.JSON(http.StatusOK, gin.H{"presets": catalog.All()})
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
	// Persist the curated model list (capabilities + pricing) and provider-
	// specific extra config. Both are validated as JSON; an explicit empty/array
	// clears the column, while an omitted field leaves the existing value intact.
	if p.Models != nil {
		if !json.Valid(p.Models) {
			return nil, errInvalidJSON("models")
		}
		row.Models = string(p.Models)
	}
	if p.Extra != nil {
		if !json.Valid(p.Extra) {
			return nil, errInvalidJSON("extra")
		}
		row.ExtraJSON = string(p.Extra)
	}
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

func errInvalidJSON(field string) error { return fmt.Errorf("%s 不是合法的 JSON", field) }

func contextWithTimeout(c *gin.Context, d time.Duration) (context.Context, context.CancelFunc) {
	return context.WithTimeout(c.Request.Context(), d)
}

// mergeModels unions the operator-curated list, live discovery, and the preset
// catalog into a single candidate set for the model editor — curated intent
// wins, live confirms availability, catalog fills capabilities/pricing/context.
// Nothing is persisted; the client reviews then PUTs via SaveModels.
func mergeModels(row *aimodel.AIProvider, live []provider.ModelInfo) []provider.ModelInfo {
	byID := map[string]provider.ModelInfo{}
	order := []string{}
	add := func(m provider.ModelInfo) {
		if m.ID == "" {
			return
		}
		if _, ok := byID[m.ID]; !ok {
			order = append(order, m.ID)
		}
		byID[m.ID] = mergeOne(byID[m.ID], m)
	}
	for _, m := range parseModelList(row.Models) {
		add(m)
	}
	for _, m := range live {
		add(m)
	}
	out := make([]provider.ModelInfo, 0, len(order))
	for _, id := range order {
		m := byID[id]
		if cp, ok := catalog.ModelByKindAndID(row.Kind, id); ok {
			m = enrichFromCatalog(m, cp)
		}
		out = append(out, m)
	}
	return out
}

func mergeOne(a, b provider.ModelInfo) provider.ModelInfo {
	if a.ID == "" {
		a.ID = b.ID
	}
	if a.Label == "" {
		a.Label = b.Label
	}
	if a.ContextWindow == 0 {
		a.ContextWindow = b.ContextWindow
	}
	if a.MaxOutput == 0 {
		a.MaxOutput = b.MaxOutput
	}
	a.Tools = a.Tools || b.Tools
	a.Vision = a.Vision || b.Vision
	a.Reasoning = a.Reasoning || b.Reasoning
	a.Caching = a.Caching || b.Caching
	if a.Pricing == nil {
		a.Pricing = b.Pricing
	}
	return a
}

func enrichFromCatalog(m provider.ModelInfo, cp catalog.ModelPreset) provider.ModelInfo {
	if m.Label == "" {
		m.Label = cp.Label
	}
	if m.ContextWindow == 0 {
		m.ContextWindow = cp.ContextWindow
	}
	if m.MaxOutput == 0 {
		m.MaxOutput = cp.MaxOutput
	}
	m.Tools = m.Tools || cp.Tools
	m.Vision = m.Vision || cp.Vision
	m.Reasoning = m.Reasoning || cp.Reasoning
	m.Caching = m.Caching || cp.Caching
	if m.Pricing == nil && (cp.InPerMTok > 0 || cp.OutPerMTok > 0) {
		m.Pricing = &provider.ModelPricing{
			InPerMTok:         cp.InPerMTok,
			OutPerMTok:        cp.OutPerMTok,
			CacheReadPerMTok:  cp.CacheReadPerMTok,
			CacheWritePerMTok: cp.CacheWritePerMTok,
		}
	}
	return m
}
