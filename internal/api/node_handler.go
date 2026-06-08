package api

import (
	"context"
	"encoding/json"
	"fmt"
	"net"
	"net/http"
	"sort"
	"strconv"
	"strings"
	"sync"
	"time"

	"github.com/gin-gonic/gin"
	"github.com/michongs/jumpserver-anonymous/internal/asset"
	"github.com/michongs/jumpserver-anonymous/internal/auth"
	"github.com/michongs/jumpserver-anonymous/internal/dialer"
	"github.com/michongs/jumpserver-anonymous/internal/model"
	"github.com/michongs/jumpserver-anonymous/internal/repo"
	appssh "github.com/michongs/jumpserver-anonymous/internal/ssh"
	"github.com/redis/go-redis/v9"
	"golang.org/x/net/proxy"
)

type NodeHandler struct {
	Repo *repo.NodeRepo
	// Creds + Proxies power list-time name resolution (so the UI never shows a
	// bare #id); Resolver + Creds also power the /test + /probe connectivity
	// checks. Tags resolves the node's managed colour tags. All optional —
	// List/Get/Test degrade gracefully when nil.
	Creds    *repo.CredentialRepo
	Proxies  *repo.ProxyRepo
	Tags     *repo.TagRepo
	Resolver *appssh.Resolver
	// Chain dials probes through a node's proxy chain; Access enforces that a
	// caller only probes nodes they hold a connect grant for (no reachability
	// leak); Cache memoises probe verdicts for a few seconds so repeated tree
	// expansions don't hammer targets. All optional.
	Chain  *dialer.ChainBuilder
	Access *asset.Resolver
	Cache  *redis.Client
}

// nodeView is the list projection — the node plus resolved human names for its
// credential and proxy-chain hops, plus its managed colour tags, so the UI can
// render everything without follow-up requests.
type nodeView struct {
	model.Node
	CredentialName string           `json:"credential_name,omitempty"`
	ProxyNames     []string         `json:"proxy_names,omitempty"`
	TagList        []model.AssetTag `json:"tag_list"`
}

func (h *NodeHandler) List(c *gin.Context) {
	ctx := c.Request.Context()
	nodes, err := h.Repo.List(ctx)
	if err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": err.Error()})
		return
	}

	// Resolve names once.
	credNames := map[uint64]string{}
	if h.Creds != nil {
		if creds, e := h.Creds.List(ctx); e == nil {
			for _, cr := range creds {
				credNames[cr.ID] = cr.Name
			}
		}
	}
	proxyNames := map[uint64]string{}
	if h.Proxies != nil {
		if ps, e := h.Proxies.List(ctx); e == nil {
			for _, p := range ps {
				proxyNames[p.ID] = p.Name
			}
		}
	}

	// Query params: q / protocol / tag / enabled / sort / order.
	q := strings.ToLower(strings.TrimSpace(c.Query("q")))
	protocol := strings.TrimSpace(c.Query("protocol"))
	tag := strings.ToLower(strings.TrimSpace(c.Query("tag")))
	enabled := strings.TrimSpace(c.Query("enabled"))
	sortKey := strings.TrimSpace(c.Query("sort"))
	order := strings.ToLower(strings.TrimSpace(c.Query("order")))

	views := make([]nodeView, 0, len(nodes))
	for i := range nodes {
		n := nodes[i]
		if protocol != "" && string(n.Protocol) != protocol {
			continue
		}
		if enabled == "true" && n.Disabled {
			continue
		}
		if enabled == "false" && !n.Disabled {
			continue
		}
		if tag != "" && !hasTag(n.Tags, tag) {
			continue
		}
		if q != "" && !nodeMatches(n, q) {
			continue
		}
		v := nodeView{Node: n, TagList: []model.AssetTag{}}
		if name, ok := credNames[n.CredentialID]; ok {
			v.CredentialName = name
		}
		v.ProxyNames = resolveChainNames(n.ProxyChain, proxyNames)
		views = append(views, v)
	}

	// Batch-resolve managed colour tags for the visible nodes (two queries).
	if h.Tags != nil && len(views) > 0 {
		ids := make([]uint64, 0, len(views))
		for i := range views {
			ids = append(ids, views[i].ID)
		}
		if byNode, e := h.Tags.TagsForNodes(ctx, ids); e == nil {
			for i := range views {
				if tl := byNode[views[i].ID]; tl != nil {
					views[i].TagList = tl
				}
			}
		}
	}

	sortNodeViews(views, sortKey, order)
	c.JSON(http.StatusOK, gin.H{"nodes": views})
}

func nodeMatches(n model.Node, q string) bool {
	hay := strings.ToLower(strings.Join([]string{
		n.Name, n.Host, n.Username, n.Description, n.Region, n.Tags, string(n.Protocol),
	}, " "))
	return strings.Contains(hay, q)
}

func hasTag(tags, want string) bool {
	for _, t := range strings.Split(tags, ",") {
		if strings.ToLower(strings.TrimSpace(t)) == want {
			return true
		}
	}
	return false
}

func resolveChainNames(chain string, names map[uint64]string) []string {
	chain = strings.TrimSpace(chain)
	if chain == "" {
		return nil
	}
	out := []string{}
	for _, part := range strings.Split(chain, ",") {
		part = strings.TrimSpace(part)
		if part == "" {
			continue
		}
		id, err := strconv.ParseUint(part, 10, 64)
		if err != nil {
			continue
		}
		if name, ok := names[id]; ok {
			out = append(out, name)
		} else {
			out = append(out, "#"+part)
		}
	}
	return out
}

func sortNodeViews(views []nodeView, key, order string) {
	desc := order == "desc"
	less := func(i, j int) bool { return false }
	switch key {
	case "protocol":
		less = func(i, j int) bool { return views[i].Protocol < views[j].Protocol }
	case "host":
		less = func(i, j int) bool { return views[i].Host < views[j].Host }
	case "created_at":
		less = func(i, j int) bool { return views[i].CreatedAt.Before(views[j].CreatedAt) }
	case "updated_at":
		less = func(i, j int) bool { return views[i].UpdatedAt.Before(views[j].UpdatedAt) }
	case "name":
		less = func(i, j int) bool { return strings.ToLower(views[i].Name) < strings.ToLower(views[j].Name) }
	default:
		return // preserve repo order (id)
	}
	sort.SliceStable(views, func(i, j int) bool {
		if desc {
			return less(j, i)
		}
		return less(i, j)
	})
}

func (h *NodeHandler) Get(c *gin.Context) {
	id, _ := strconv.ParseUint(c.Param("id"), 10, 64)
	n, err := h.Repo.FindByID(c.Request.Context(), id)
	if err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": err.Error()})
		return
	}
	if n == nil {
		c.JSON(http.StatusNotFound, gin.H{"error": "not found"})
		return
	}
	v := nodeView{Node: *n, TagList: []model.AssetTag{}}
	if h.Creds != nil {
		if cr, e := h.Creds.FindByID(c.Request.Context(), n.CredentialID); e == nil && cr != nil {
			v.CredentialName = cr.Name
		}
	}
	if h.Proxies != nil {
		if ps, e := h.Proxies.List(c.Request.Context()); e == nil {
			names := map[uint64]string{}
			for _, p := range ps {
				names[p.ID] = p.Name
			}
			v.ProxyNames = resolveChainNames(n.ProxyChain, names)
		}
	}
	if h.Tags != nil {
		if tl, e := h.Tags.TagsForNode(c.Request.Context(), n.ID); e == nil && tl != nil {
			v.TagList = tl
		}
	}
	c.JSON(http.StatusOK, v)
}

func (h *NodeHandler) Create(c *gin.Context) {
	var n model.Node
	if err := c.ShouldBindJSON(&n); err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"error": err.Error()})
		return
	}
	if err := h.Repo.Create(c.Request.Context(), &n); err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": err.Error()})
		return
	}
	c.JSON(http.StatusCreated, n)
}

func (h *NodeHandler) Update(c *gin.Context) {
	id, _ := strconv.ParseUint(c.Param("id"), 10, 64)
	n, err := h.Repo.FindByID(c.Request.Context(), id)
	if err != nil || n == nil {
		c.JSON(http.StatusNotFound, gin.H{"error": "not found"})
		return
	}
	if err := c.ShouldBindJSON(n); err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"error": err.Error()})
		return
	}
	n.ID = id
	if err := h.Repo.Update(c.Request.Context(), n); err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": err.Error()})
		return
	}
	c.JSON(http.StatusOK, n)
}

func (h *NodeHandler) Delete(c *gin.Context) {
	id, _ := strconv.ParseUint(c.Param("id"), 10, 64)
	if err := h.Repo.Delete(c.Request.Context(), id); err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": err.Error()})
		return
	}
	c.JSON(http.StatusOK, gin.H{"ok": true})
}

// Test probes reachability for a node. SSH/Telnet nodes get a full auth
// handshake (when a credential is configured); every other protocol gets a
// plain TCP dial to confirm the port is open. Always 200 with {ok}.
func (h *NodeHandler) Test(c *gin.Context) {
	id, _ := strconv.ParseUint(c.Param("id"), 10, 64)
	n, err := h.Repo.FindByID(c.Request.Context(), id)
	if err != nil || n == nil {
		c.JSON(http.StatusNotFound, gin.H{"error": "not found"})
		return
	}
	addr := appssh.AddrOf(n.Host, n.Port)
	proto := n.EffectiveProtocol()

	// SSH-family with a credential → real auth handshake.
	if (proto == model.NodeProtoSSH || proto == model.NodeProtoTelnet) && h.Resolver != nil && h.Creds != nil && n.CredentialID != 0 {
		cred, cerr := h.Creds.FindByID(c.Request.Context(), n.CredentialID)
		if cerr == nil && cred != nil {
			methods, merr := h.Resolver.AuthMethods(cred)
			if merr != nil {
				c.JSON(http.StatusOK, gin.H{"ok": false, "mode": "ssh", "error": "凭证材料无效: " + merr.Error()})
				return
			}
			start := time.Now()
			client, derr := appssh.Connect(c.Request.Context(), proxy.Direct, appssh.DialConfig{
				Addr:    addr,
				User:    appssh.PreferredUser(cred, n.Username),
				Auth:    methods,
				Timeout: 8 * time.Second,
			})
			latency := time.Since(start).Milliseconds()
			if derr != nil {
				c.JSON(http.StatusOK, gin.H{"ok": false, "mode": "ssh", "error": derr.Error(), "latency_ms": latency})
				return
			}
			_ = client.Close()
			c.JSON(http.StatusOK, gin.H{"ok": true, "mode": "ssh", "latency_ms": latency, "target": addr})
			return
		}
	}

	// Everything else (or SSH without a credential) → TCP reachability.
	start := time.Now()
	conn, derr := net.DialTimeout("tcp", addr, 8*time.Second)
	latency := time.Since(start).Milliseconds()
	if derr != nil {
		c.JSON(http.StatusOK, gin.H{"ok": false, "mode": "tcp", "error": derr.Error(), "latency_ms": latency})
		return
	}
	_ = conn.Close()
	c.JSON(http.StatusOK, gin.H{"ok": true, "mode": "tcp", "latency_ms": latency, "target": addr})
}

// BatchEnable / BatchDisable flip the disabled flag for many nodes in one
// request — the asset tree's bulk 启用 / 停用 action.
func (h *NodeHandler) BatchEnable(c *gin.Context)  { h.batchSetDisabled(c, false) }
func (h *NodeHandler) BatchDisable(c *gin.Context) { h.batchSetDisabled(c, true) }

func (h *NodeHandler) batchSetDisabled(c *gin.Context, disabled bool) {
	var body struct {
		IDs []uint64 `json:"ids"`
	}
	if err := c.ShouldBindJSON(&body); err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"error": err.Error()})
		return
	}
	if len(body.IDs) == 0 {
		c.JSON(http.StatusBadRequest, gin.H{"error": "ids 不能为空"})
		return
	}
	if err := h.Repo.SetDisabledBatch(c.Request.Context(), body.IDs, disabled); err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": err.Error()})
		return
	}
	c.JSON(http.StatusOK, gin.H{"ok": len(body.IDs)})
}

// ----- On-demand status probe -----
//
// Unlike Test (admin diagnostics, direct dial), the probe endpoints power the
// asset tree's live status dots: they dial THROUGH the node's proxy chain, cap
// concurrency, cache verdicts for a few seconds, and — crucially — refuse to
// probe nodes the caller has no connect grant for, so a logged-in user can't
// map reachability of assets they can't access.

const probeCacheTTL = 20 * time.Second
const probeBatchCap = 200
const probeConcurrency = 8

// probeResult is one node's connectivity verdict. online is the single field
// the frontend keys its status dot on.
type probeResult struct {
	ID        uint64    `json:"id"`
	Online    bool      `json:"online"`
	Mode      string    `json:"mode,omitempty"` // ssh | tcp | chain
	LatencyMS int64     `json:"latency_ms"`
	Target    string    `json:"target,omitempty"`
	Error     string    `json:"error,omitempty"`
	Forbidden bool      `json:"forbidden,omitempty"`
	Cached    bool      `json:"cached,omitempty"`
	CheckedAt time.Time `json:"checked_at"`
}

func probeCacheKey(id uint64) string { return fmt.Sprintf("probe:node:%d", id) }

func (h *NodeHandler) cachedProbe(ctx context.Context, id uint64) (probeResult, bool) {
	if h.Cache == nil {
		return probeResult{}, false
	}
	raw, err := h.Cache.Get(ctx, probeCacheKey(id)).Result()
	if err != nil || raw == "" {
		return probeResult{}, false
	}
	var r probeResult
	if json.Unmarshal([]byte(raw), &r) != nil {
		return probeResult{}, false
	}
	r.Cached = true
	return r, true
}

func (h *NodeHandler) storeProbe(ctx context.Context, r probeResult) {
	if h.Cache == nil {
		return
	}
	if b, err := json.Marshal(r); err == nil {
		_ = h.Cache.Set(ctx, probeCacheKey(r.ID), b, probeCacheTTL).Err()
	}
}

// probe runs one connectivity check for a node THROUGH its proxy chain. SSH/
// Telnet with a credential get a real auth handshake; everything else gets a
// plain TCP dial. The bastion chain is refcounted, so release() must run.
func (h *NodeHandler) probe(ctx context.Context, n *model.Node) probeResult {
	res := probeResult{ID: n.ID, CheckedAt: time.Now()}
	addr := appssh.AddrOf(n.Host, n.Port)
	res.Target = addr
	proto := n.EffectiveProtocol()

	// Build the proxy-chain dialer. An empty chain → Build supplies a bounded
	// Direct base, so finalDialer is always usable.
	var finalDialer proxy.ContextDialer = proxy.Direct
	if h.Chain != nil {
		hops, herr := resolveProxyHops(ctx, h.Proxies, n.ProxyChain)
		if herr != nil {
			res.Mode = "chain"
			res.Error = herr.Error()
			return res
		}
		d, release, berr := h.Chain.Build(ctx, hops, nil)
		if berr != nil {
			res.Mode = "chain"
			res.Error = berr.Error()
			return res
		}
		defer release()
		finalDialer = d
	}

	pctx, cancel := context.WithTimeout(ctx, 8*time.Second)
	defer cancel()

	// SSH-family with a credential → real auth handshake through the chain.
	if (proto == model.NodeProtoSSH || proto == model.NodeProtoTelnet) && h.Resolver != nil && h.Creds != nil && n.CredentialID != 0 {
		if cred, cerr := h.Creds.FindByID(pctx, n.CredentialID); cerr == nil && cred != nil {
			res.Mode = "ssh"
			methods, merr := h.Resolver.AuthMethods(cred)
			if merr != nil {
				res.Error = "凭证材料无效: " + merr.Error()
				return res
			}
			start := time.Now()
			client, derr := appssh.Connect(pctx, finalDialer, appssh.DialConfig{
				Addr:    addr,
				User:    appssh.PreferredUser(cred, n.Username),
				Auth:    methods,
				Timeout: 8 * time.Second,
			})
			res.LatencyMS = time.Since(start).Milliseconds()
			if derr != nil {
				res.Error = derr.Error()
				return res
			}
			_ = client.Close()
			res.Online = true
			return res
		}
	}

	// Everything else (or SSH without a credential) → TCP reachability.
	res.Mode = "tcp"
	start := time.Now()
	conn, derr := finalDialer.DialContext(pctx, "tcp", addr)
	res.LatencyMS = time.Since(start).Milliseconds()
	if derr != nil {
		res.Error = derr.Error()
		return res
	}
	_ = conn.Close()
	res.Online = true
	return res
}

// mayProbe is the per-node IDOR gate: the caller must hold a connect grant.
// Admins pass via the resolver's "all" sentinel.
func (h *NodeHandler) mayProbe(ctx context.Context, nodeID uint64) bool {
	if h.Access == nil {
		return true
	}
	claims := auth.FromContext(ctx)
	if claims == nil {
		return false
	}
	ok, err := h.Access.Check(ctx, claims.UserID, nodeID, asset.ActionConnect)
	return err == nil && ok
}

// allowedSet resolves which of the requested ids the caller may probe. The
// bool return is the "all assets" sentinel (admins / 全部资产 grants), where the
// map is nil and every id is allowed.
func (h *NodeHandler) allowedSet(ctx context.Context) (map[uint64]bool, bool) {
	if h.Access == nil {
		return nil, true
	}
	claims := auth.FromContext(ctx)
	if claims == nil {
		return map[uint64]bool{}, false
	}
	visible, all, err := h.Access.VisibleNodeIDs(ctx, claims.UserID, asset.ActionConnect)
	if err != nil {
		return map[uint64]bool{}, false
	}
	if all {
		return nil, true
	}
	set := make(map[uint64]bool, len(visible))
	for _, id := range visible {
		set[id] = true
	}
	return set, false
}

// Probe is the single-node on-demand status check (cached ~20s).
func (h *NodeHandler) Probe(c *gin.Context) {
	id, _ := strconv.ParseUint(c.Param("id"), 10, 64)
	ctx := c.Request.Context()
	if !h.mayProbe(ctx, id) {
		c.JSON(http.StatusForbidden, gin.H{"error": "无权探测该资产"})
		return
	}
	if r, ok := h.cachedProbe(ctx, id); ok {
		c.JSON(http.StatusOK, r)
		return
	}
	n, err := h.Repo.FindByID(ctx, id)
	if err != nil || n == nil {
		c.JSON(http.StatusNotFound, gin.H{"error": "not found"})
		return
	}
	r := h.probe(ctx, n)
	h.storeProbe(ctx, r)
	c.JSON(http.StatusOK, r)
}

// ProbeBatch probes many nodes at once for the tree's status dots. Ids the
// caller can't access come back marked forbidden (never silently probed);
// cached verdicts are reused; live probes run with bounded concurrency.
func (h *NodeHandler) ProbeBatch(c *gin.Context) {
	var body struct {
		IDs []uint64 `json:"ids"`
	}
	if err := c.ShouldBindJSON(&body); err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"error": err.Error()})
		return
	}
	ctx := c.Request.Context()

	// Dedup + cap.
	seen := map[uint64]bool{}
	ids := make([]uint64, 0, len(body.IDs))
	for _, id := range body.IDs {
		if id == 0 || seen[id] {
			continue
		}
		seen[id] = true
		ids = append(ids, id)
		if len(ids) >= probeBatchCap {
			break
		}
	}

	allowed, allowAll := h.allowedSet(ctx)

	// Distinct index per worker → no shared-slice race; wg.Wait orders the read.
	results := make([]probeResult, len(ids))
	var wg sync.WaitGroup
	sem := make(chan struct{}, probeConcurrency)
	for i, id := range ids {
		if !allowAll && !allowed[id] {
			results[i] = probeResult{ID: id, Forbidden: true, CheckedAt: time.Now()}
			continue
		}
		if r, ok := h.cachedProbe(ctx, id); ok {
			results[i] = r
			continue
		}
		n, err := h.Repo.FindByID(ctx, id)
		if err != nil || n == nil {
			results[i] = probeResult{ID: id, Error: "not found", CheckedAt: time.Now()}
			continue
		}
		wg.Add(1)
		sem <- struct{}{}
		go func(i int, node *model.Node) {
			defer wg.Done()
			defer func() { <-sem }()
			r := h.probe(ctx, node)
			h.storeProbe(ctx, r)
			results[i] = r
		}(i, n)
	}
	wg.Wait()
	c.JSON(http.StatusOK, gin.H{"results": results})
}

// resolveProxyHops turns a node's comma-separated proxy-chain id list into the
// proxy rows the ChainBuilder needs. Empty chain → nil (Direct base).
func resolveProxyHops(ctx context.Context, proxies *repo.ProxyRepo, chain string) ([]*model.Proxy, error) {
	chain = strings.TrimSpace(chain)
	if chain == "" || proxies == nil {
		return nil, nil
	}
	out := make([]*model.Proxy, 0, 4)
	for _, raw := range strings.Split(chain, ",") {
		raw = strings.TrimSpace(raw)
		if raw == "" {
			continue
		}
		id, err := strconv.ParseUint(raw, 10, 64)
		if err != nil {
			return nil, fmt.Errorf("invalid proxy id %q", raw)
		}
		p, err := proxies.FindByID(ctx, id)
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
