package api

import (
	"context"
	"errors"
	"fmt"
	"net/http"
	"strconv"
	"strings"
	"time"

	"github.com/gin-gonic/gin"
	"github.com/michongs/jumpserver-anonymous/internal/dialer"
	"github.com/michongs/jumpserver-anonymous/internal/model"
	"github.com/michongs/jumpserver-anonymous/internal/repo"
)

// ProxyHandler exposes proxy CRUD plus the Phase 10 chain operations
// (validate / test / templates). The handler stays read-only on the dialer
// stack — Builder.Build is reused so we don't drift from runtime behaviour.
type ProxyHandler struct {
	Repo      *repo.ProxyRepo
	Templates *repo.ChainTemplateRepo
	Builder   *dialer.ChainBuilder
}

func (h *ProxyHandler) List(c *gin.Context) {
	out, err := h.Repo.List(c.Request.Context())
	if err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": err.Error()})
		return
	}
	// Augment with per-kind / per-credential summary so the UI can render
	// counts without round-tripping. Kept tiny — no N+1 query.
	counts := map[model.ProxyKind]int{}
	for _, p := range out {
		counts[p.Kind]++
	}
	c.JSON(http.StatusOK, gin.H{
		"proxies": out,
		"summary": gin.H{
			"total":  len(out),
			"by_kind": counts,
			"kinds":  model.AllProxyKinds,
		},
	})
}

func (h *ProxyHandler) Create(c *gin.Context) {
	var p model.Proxy
	if err := c.ShouldBindJSON(&p); err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"error": err.Error()})
		return
	}
	if err := validateProxyShape(&p); err != nil {
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
	if err := validateProxyShape(p); err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"error": err.Error()})
		return
	}
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

// ValidateChainRequest is the body of POST /admin/proxies/chains/validate.
// Chain is the same comma-separated proxy-id string used by node.ProxyChain
// so the front-end can post either the input draft or an existing node value.
type ValidateChainRequest struct {
	Chain string `json:"chain"`
}

func (h *ProxyHandler) ValidateChain(c *gin.Context) {
	var req ValidateChainRequest
	if err := c.ShouldBindJSON(&req); err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"error": err.Error()})
		return
	}
	hops, resolveErr := resolveChain(c.Request.Context(), h.Repo, req.Chain)
	issues := dialer.ValidateChainShape(hops)
	c.JSON(http.StatusOK, gin.H{
		"hops":    hops,
		"issues":  issues,
		"valid":   resolveErr == nil && !dialer.HasBlockingIssue(issues),
		"resolve": errorString(resolveErr),
	})
}

// TestChainRequest probes a chain end-to-end and optionally a downstream
// target host:port. Target is optional; without it the probe stops at "could
// the chain build at all" which is enough for catching credential errors and
// kind mismatches.
type TestChainRequest struct {
	Chain   string `json:"chain"`
	Target  string `json:"target,omitempty"`
	Timeout int    `json:"timeout_seconds,omitempty"`
}

func (h *ProxyHandler) TestChain(c *gin.Context) {
	var req TestChainRequest
	if err := c.ShouldBindJSON(&req); err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"error": err.Error()})
		return
	}
	hops, resolveErr := resolveChain(c.Request.Context(), h.Repo, req.Chain)
	if resolveErr != nil {
		c.JSON(http.StatusBadRequest, gin.H{"error": resolveErr.Error()})
		return
	}
	if h.Builder == nil {
		c.JSON(http.StatusServiceUnavailable, gin.H{"error": "chain builder not configured"})
		return
	}
	timeout := time.Duration(req.Timeout) * time.Second
	if timeout <= 0 || timeout > 60*time.Second {
		timeout = 10 * time.Second
	}
	ctx, cancel := context.WithTimeout(c.Request.Context(), timeout)
	defer cancel()
	results := h.Builder.Test(ctx, hops, req.Target)
	allOK := true
	for _, r := range results {
		if !r.OK {
			allOK = false
		}
	}
	c.JSON(http.StatusOK, gin.H{
		"hops":    hops,
		"results": results,
		"ok":      allOK,
		"target":  req.Target,
	})
}

// resolveChain converts a comma-separated proxy id list to []*model.Proxy
// preserving order. Mirrors webssh/gateway.go:resolveHops but lives at the
// API layer so handlers without a gateway can reuse it.
func resolveChain(ctx context.Context, r *repo.ProxyRepo, chain string) ([]*model.Proxy, error) {
	if strings.TrimSpace(chain) == "" {
		return nil, nil
	}
	parts := strings.Split(chain, ",")
	out := make([]*model.Proxy, 0, len(parts))
	for _, raw := range parts {
		s := strings.TrimSpace(raw)
		if s == "" {
			continue
		}
		id, err := strconv.ParseUint(s, 10, 64)
		if err != nil {
			return nil, fmt.Errorf("invalid proxy id %q", s)
		}
		p, err := r.FindByID(ctx, id)
		if err != nil {
			return nil, err
		}
		if p == nil {
			return nil, fmt.Errorf("proxy %d not found", id)
		}
		out = append(out, p)
	}
	return out, nil
}

func validateProxyShape(p *model.Proxy) error {
	if strings.TrimSpace(p.Name) == "" {
		return errors.New("name required")
	}
	switch p.Kind {
	case model.ProxyDirect:
		// direct does not need host/port
	case model.ProxySOCKS5, model.ProxyHTTPConn:
		if strings.TrimSpace(p.Host) == "" || p.Port <= 0 {
			return fmt.Errorf("%s proxy requires host and port", p.Kind)
		}
	case model.ProxyBastion:
		if strings.TrimSpace(p.Host) == "" || p.Port <= 0 {
			return errors.New("bastion proxy requires host and port")
		}
		if p.CredentialID == nil {
			return errors.New("bastion proxy requires a credential")
		}
	default:
		return fmt.Errorf("unsupported proxy kind %q", p.Kind)
	}
	return nil
}

func errorString(err error) string {
	if err == nil {
		return ""
	}
	return err.Error()
}
