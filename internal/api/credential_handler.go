package api

import (
	"net/http"
	"strconv"
	"strings"
	"time"

	"github.com/gin-gonic/gin"
	"github.com/michongs/wayfort/internal/model"
	"github.com/michongs/wayfort/internal/repo"
	appssh "github.com/michongs/wayfort/internal/ssh"
	pkgcrypto "github.com/michongs/wayfort/pkg/crypto"
	"golang.org/x/net/proxy"
)

type CredentialHandler struct {
	Repo   *repo.CredentialRepo
	Sealer pkgcrypto.Vault
	// Resolver + Nodes power the connectivity-test endpoint. Both are
	// optional: when nil, /test returns 503 instead of panicking, so the
	// handler degrades gracefully if wired without them.
	Resolver *appssh.Resolver
	Nodes    *repo.NodeRepo
}

type credPayload struct {
	Name        string     `json:"name" binding:"required"`
	Kind        string     `json:"kind" binding:"required"`
	Username    string     `json:"username"`
	Secret      string     `json:"secret"`
	Passphrase  string     `json:"passphrase"`
	Description string     `json:"description"`
	Tags        string     `json:"tags"`
	ExpiresAt   *time.Time `json:"expires_at"`
	// RequiresApprovalForUse is a pointer so "omitted" is distinct from
	// "explicitly false" — only applied when the client sends it.
	RequiresApprovalForUse *bool `json:"requires_approval_for_use"`
}

// credView is the list/detail projection: the credential row (secrets stripped
// via json:"-") enriched with reference tallies so the UI can render "used by
// N nodes / M proxies" without extra round-trips.
type credView struct {
	model.Credential
	UsageNodes   int `json:"usage_nodes"`
	UsageProxies int `json:"usage_proxies"`
}

func (h *CredentialHandler) List(c *gin.Context) {
	rows, err := h.Repo.List(c.Request.Context())
	if err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": err.Error()})
		return
	}
	counts, err := h.Repo.UsageCounts(c.Request.Context())
	if err != nil {
		// Usage tallies are a nicety, not a hard requirement — degrade to
		// zeros rather than failing the whole list.
		counts = map[uint64]repo.CredUsageCount{}
	}
	views := make([]credView, 0, len(rows))
	for i := range rows {
		u := counts[rows[i].ID]
		views = append(views, credView{Credential: rows[i], UsageNodes: u.Nodes, UsageProxies: u.Proxies})
	}
	c.JSON(http.StatusOK, gin.H{"credentials": views})
}

func (h *CredentialHandler) Create(c *gin.Context) {
	var p credPayload
	if err := c.ShouldBindJSON(&p); err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"error": err.Error()})
		return
	}
	if strings.TrimSpace(p.Secret) == "" {
		c.JSON(http.StatusBadRequest, gin.H{"error": "secret is required when creating a credential"})
		return
	}
	row, err := h.payloadToRow(p, nil)
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

func (h *CredentialHandler) Update(c *gin.Context) {
	id, _ := strconv.ParseUint(c.Param("id"), 10, 64)
	row, err := h.Repo.FindByID(c.Request.Context(), id)
	if err != nil || row == nil {
		c.JSON(http.StatusNotFound, gin.H{"error": "not found"})
		return
	}
	var p credPayload
	if err := c.ShouldBindJSON(&p); err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"error": err.Error()})
		return
	}
	row, err = h.payloadToRow(p, row)
	if err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"error": err.Error()})
		return
	}
	row.ID = id
	if err := h.Repo.Update(c.Request.Context(), row); err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": err.Error()})
		return
	}
	c.JSON(http.StatusOK, gin.H{"id": id})
}

func (h *CredentialHandler) Delete(c *gin.Context) {
	id, _ := strconv.ParseUint(c.Param("id"), 10, 64)
	force := c.Query("force") == "true" || c.Query("force") == "1"

	nodes, proxies, err := h.Repo.UsageOf(c.Request.Context(), id)
	if err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": err.Error()})
		return
	}
	if (len(nodes) > 0 || len(proxies) > 0) && !force {
		// Referential-integrity guard: refuse the delete and hand back the
		// exact list of referencing resources so the UI can show "used by …"
		// and offer an explicit force-delete.
		c.JSON(http.StatusConflict, gin.H{
			"error":   "credential is still in use",
			"code":    "credential_in_use",
			"nodes":   nodes,
			"proxies": proxies,
		})
		return
	}
	if err := h.Repo.Delete(c.Request.Context(), id); err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": err.Error()})
		return
	}
	c.JSON(http.StatusOK, gin.H{"ok": true})
}

// Usage returns the nodes + proxies that reference this credential.
func (h *CredentialHandler) Usage(c *gin.Context) {
	id, _ := strconv.ParseUint(c.Param("id"), 10, 64)
	nodes, proxies, err := h.Repo.UsageOf(c.Request.Context(), id)
	if err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": err.Error()})
		return
	}
	c.JSON(http.StatusOK, gin.H{"nodes": nodes, "proxies": proxies})
}

type credTestPayload struct {
	NodeID *uint64 `json:"node_id"`
	Host   string  `json:"host"`
	Port   int     `json:"port"`
}

// Test performs a live SSH handshake using the credential against a target
// (an existing node or an ad-hoc host:port) and reports the outcome. Always
// responds 200 with an {ok} field so the frontend treats failures as data,
// not transport errors. The connection is a direct dial (no proxy chain) —
// it validates credential material + reachability, not chain topology.
func (h *CredentialHandler) Test(c *gin.Context) {
	if h.Resolver == nil {
		c.JSON(http.StatusServiceUnavailable, gin.H{"error": "connectivity testing not available"})
		return
	}
	id, _ := strconv.ParseUint(c.Param("id"), 10, 64)
	cred, err := h.Repo.FindByID(c.Request.Context(), id)
	if err != nil || cred == nil {
		c.JSON(http.StatusNotFound, gin.H{"error": "not found"})
		return
	}

	var p credTestPayload
	_ = c.ShouldBindJSON(&p)

	host, port, override := p.Host, p.Port, ""
	if p.NodeID != nil && h.Nodes != nil {
		node, nerr := h.Nodes.FindByID(c.Request.Context(), *p.NodeID)
		if nerr != nil || node == nil {
			c.JSON(http.StatusBadRequest, gin.H{"error": "target node not found"})
			return
		}
		host, port, override = node.Host, node.Port, node.Username
	}
	if strings.TrimSpace(host) == "" {
		c.JSON(http.StatusBadRequest, gin.H{"error": "a target node_id or host is required"})
		return
	}

	methods, err := h.Resolver.AuthMethods(cred)
	if err != nil {
		_ = h.Repo.TouchLastTested(c.Request.Context(), id, false)
		c.JSON(http.StatusOK, gin.H{"ok": false, "error": "凭证材料无效: " + err.Error()})
		return
	}

	start := time.Now()
	client, derr := appssh.Connect(c.Request.Context(), proxy.Direct, appssh.DialConfig{
		Addr:    appssh.AddrOf(host, port),
		User:    appssh.PreferredUser(cred, override),
		Auth:    methods,
		Timeout: 8 * time.Second,
	})
	latency := time.Since(start).Milliseconds()
	if derr != nil {
		_ = h.Repo.TouchLastTested(c.Request.Context(), id, false)
		c.JSON(http.StatusOK, gin.H{"ok": false, "error": derr.Error(), "latency_ms": latency})
		return
	}
	_ = client.Close()
	_ = h.Repo.TouchLastTested(c.Request.Context(), id, true)
	c.JSON(http.StatusOK, gin.H{"ok": true, "latency_ms": latency, "target": appssh.AddrOf(host, port)})
}

func (h *CredentialHandler) payloadToRow(p credPayload, base *model.Credential) (*model.Credential, error) {
	row := base
	if row == nil {
		row = &model.Credential{}
	}
	row.Name = p.Name
	row.Kind = model.CredentialKind(p.Kind)
	row.Username = p.Username
	row.Description = p.Description
	row.Tags = p.Tags
	row.ExpiresAt = p.ExpiresAt
	if p.RequiresApprovalForUse != nil {
		row.RequiresApprovalForUse = *p.RequiresApprovalForUse
	}

	// Secret rotation: only re-seal when a new secret is supplied. On edit, an
	// empty secret means "keep the existing one" — so grants that depend on
	// this credential row survive a metadata-only update.
	if strings.TrimSpace(p.Secret) != "" {
		sealed, err := h.Sealer.Seal([]byte(p.Secret))
		if err != nil {
			return nil, err
		}
		row.Secret = sealed
	}
	// Passphrase: a non-empty value rotates it; the literal "-" clears it
	// (e.g. switching to an unencrypted key). Empty keeps the current value.
	switch {
	case p.Passphrase == "-":
		row.Passphrase = nil
	case strings.TrimSpace(p.Passphrase) != "":
		ppt, err := h.Sealer.Seal([]byte(p.Passphrase))
		if err != nil {
			return nil, err
		}
		row.Passphrase = ppt
	}
	return row, nil
}
