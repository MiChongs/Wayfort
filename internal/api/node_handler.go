package api

import (
	"net"
	"net/http"
	"sort"
	"strconv"
	"strings"
	"time"

	"github.com/gin-gonic/gin"
	"github.com/michongs/wayfort/internal/asset"
	"github.com/michongs/wayfort/internal/model"
	"github.com/michongs/wayfort/internal/repo"
	appssh "github.com/michongs/wayfort/internal/ssh"
	"golang.org/x/net/proxy"
)

type NodeHandler struct {
	Repo *repo.NodeRepo
	// Creds + Proxies power list-time name resolution (so the UI never shows a
	// bare #id); Resolver + Creds also power the /test connectivity check. Tags
	// resolves the node's managed colour tags. All optional — List/Get/Test
	// degrade gracefully when nil.
	Creds    *repo.CredentialRepo
	Proxies  *repo.ProxyRepo
	Tags     *repo.TagRepo
	Resolver *appssh.Resolver
	// AccessItems + Access keep the 授权目录 consistent when a node is deleted:
	// purge any access-tree items that referenced it and flush the ACL cache.
	// Both optional — Delete degrades gracefully when nil.
	AccessItems *repo.AccessItemRepo
	Access      *asset.Resolver
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
	// Keep the 授权目录 clean: drop any access-tree items that pointed at this
	// node, then flush the ACL cache so it leaves everyone's directory.
	if h.AccessItems != nil {
		_ = h.AccessItems.PurgeNode(c.Request.Context(), id)
	}
	if h.Access != nil {
		h.Access.InvalidateAll(c.Request.Context())
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
