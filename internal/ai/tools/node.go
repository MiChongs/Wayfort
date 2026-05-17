package tools

import (
	"context"
	"encoding/json"
	"fmt"
	"strings"

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
}

// EnsureNodeRepo silences unused-import warnings during compile prototyping.
var _ = repo.NewNodeRepo
