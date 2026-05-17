package tools

import (
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net"
	"strconv"
	"strings"
	"time"

	"github.com/michongs/jumpserver-anonymous/internal/asset"
	"github.com/michongs/jumpserver-anonymous/internal/repo"
)

// RegisterNodeTools adds list_nodes / get_node — entirely read-only catalogue queries.
func RegisterNodeTools(reg *Registry, deps Deps) {
	reg.Register(&Tool{
		Name:        "list_nodes",
		Description: "列出当前用户可见的资产节点。可选按标签或文本搜索过滤。",
		Danger:      DangerLow,
		Schema: json.RawMessage(`{"type":"object","properties":{
			"search":{"type":"string","description":"匹配 name/host/description 的子串"}},
			"required":[]}`),
		Run: func(ctx context.Context, tctx ToolCtx, raw json.RawMessage) (string, error) {
			var args struct {
				Search string `json:"search"`
			}
			_ = json.Unmarshal(raw, &args)
			ids, all, err := deps.Asset.VisibleNodeIDs(ctx, tctx.UserID, asset.ActionConnect)
			if err != nil {
				return "", err
			}
			allRows, err := deps.Nodes.List(ctx)
			if err != nil {
				return "", err
			}
			var filtered []map[string]any
			wanted := map[uint64]bool{}
			for _, id := range ids {
				wanted[id] = true
			}
			for _, n := range allRows {
				if !all && !wanted[n.ID] {
					continue
				}
				if args.Search != "" {
					s := strings.ToLower(args.Search)
					if !strings.Contains(strings.ToLower(n.Name), s) &&
						!strings.Contains(strings.ToLower(n.Host), s) &&
						!strings.Contains(strings.ToLower(n.Description), s) {
						continue
					}
				}
				filtered = append(filtered, map[string]any{
					"id": n.ID, "name": n.Name, "protocol": n.EffectiveProtocol(),
					"host": n.Host, "port": n.Port, "tags": n.Tags,
					"region": n.Region, "description": n.Description,
				})
			}
			b, _ := json.Marshal(map[string]any{"nodes": filtered, "count": len(filtered)})
			return string(b), nil
		},
	})

	reg.Register(&Tool{
		Name:        "get_node",
		Description: "查看一个节点的详细信息，需要 node_id。",
		Danger:      DangerLow,
		RequiredAssetAction: asset.ActionConnect,
		Schema: json.RawMessage(`{"type":"object","properties":{
			"node_id":{"type":"integer","description":"节点 ID"}},
			"required":["node_id"]}`),
		Run: func(ctx context.Context, tctx ToolCtx, raw json.RawMessage) (string, error) {
			var args struct {
				NodeID uint64 `json:"node_id"`
			}
			if err := json.Unmarshal(raw, &args); err != nil || args.NodeID == 0 {
				return "", fmt.Errorf("node_id required")
			}
			n, err := deps.Nodes.FindByID(ctx, args.NodeID)
			if err != nil || n == nil {
				return "", fmt.Errorf("not found")
			}
			b, _ := json.Marshal(map[string]any{
				"id": n.ID, "name": n.Name, "protocol": n.EffectiveProtocol(),
				"host": n.Host, "port": n.Port, "username": n.Username,
				"proxy_chain": n.ProxyChain, "tags": n.Tags, "region": n.Region,
				"description": n.Description, "disabled": n.Disabled,
			})
			return string(b), nil
		},
	})

	reg.Register(&Tool{
		Name: "node_test",
		Description: "对节点做 TCP 探测：在 5 秒内连接 host:port，并尝试读取 SSH banner。" +
			"不会真的开会话，不会消耗 SSH 池槽。用于快速判断节点是否在线。",
		Danger:              DangerLow,
		RequiredAssetAction: asset.ActionConnect,
		Schema: json.RawMessage(`{"type":"object","properties":{
			"node_id":{"type":"integer"},
			"port":{"type":"integer","description":"可选；默认用节点配置的端口"}},
			"required":["node_id"]}`),
		Run: func(ctx context.Context, _ ToolCtx, raw json.RawMessage) (string, error) {
			var args struct {
				NodeID uint64 `json:"node_id"`
				Port   int    `json:"port"`
			}
			if err := json.Unmarshal(raw, &args); err != nil || args.NodeID == 0 {
				return "", fmt.Errorf("node_id required")
			}
			n, err := deps.Nodes.FindByID(ctx, args.NodeID)
			if err != nil || n == nil {
				return "", fmt.Errorf("not found")
			}
			port := args.Port
			if port == 0 {
				port = n.Port
			}
			if port == 0 {
				port = 22
			}
			addr := net.JoinHostPort(n.Host, strconv.Itoa(port))
			started := time.Now()
			dialCtx, cancel := context.WithTimeout(ctx, 5*time.Second)
			defer cancel()
			var d net.Dialer
			conn, err := d.DialContext(dialCtx, "tcp", addr)
			rttMs := time.Since(started).Milliseconds()
			result := map[string]any{
				"node_id":     n.ID,
				"name":        n.Name,
				"address":     addr,
				"rtt_ms":      rttMs,
				"reachable":   err == nil,
			}
			if err != nil {
				result["error"] = err.Error()
				b, _ := json.Marshal(result)
				return string(b), nil
			}
			defer conn.Close()
			// Try to grab the first 256 bytes within 2s — common SSH/Telnet
			// banners arrive immediately after TCP accept.
			_ = conn.SetReadDeadline(time.Now().Add(2 * time.Second))
			buf := make([]byte, 256)
			rn, rerr := conn.Read(buf)
			if rerr != nil && rerr != io.EOF {
				result["banner"] = ""
				result["banner_error"] = rerr.Error()
			} else if rn > 0 {
				banner := strings.TrimSpace(string(buf[:rn]))
				result["banner"] = banner
				if strings.HasPrefix(banner, "SSH-") {
					result["protocol"] = "ssh"
				}
			}
			b, _ := json.Marshal(result)
			return string(b), nil
		},
	})
}

// EnsureNodeRepo silences unused-import warnings during compile prototyping.
var _ = repo.NewNodeRepo
