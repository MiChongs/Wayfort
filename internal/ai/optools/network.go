package optools

import (
	"context"
	"encoding/json"
	"fmt"

	"github.com/michongs/jumpserver-anonymous/internal/ai/tools"
	"github.com/michongs/jumpserver-anonymous/internal/auth"
	"github.com/michongs/jumpserver-anonymous/internal/nettools"
)

func registerNetworkTools(reg *tools.Registry, deps Deps) {
	if deps.NetTools == nil {
		return
	}

	nodeReadTool(reg, "net_info",
		"获取节点网络概览：接口与 IP、路由表、活动连接、监听端口。",
		objSchema(nodeIDProp, "node_id"),
		func(ctx context.Context, t tools.ToolCtx, raw json.RawMessage, nid uint64) (string, error) {
			info, err := deps.NetTools.Info(ctx, t.UserID, nid)
			if err != nil {
				return "", err
			}
			return view("net_info", info)
		})

	netDiag(reg, deps, "net_ping", "对目标主机执行 ping 连通性探测。", nettools.ToolPing)
	netDiag(reg, deps, "net_traceroute", "对目标主机执行 traceroute 路由追踪。", nettools.ToolTraceroute)
	netDiag(reg, deps, "net_dns", "对域名执行 DNS 解析(dig)。", nettools.ToolDig)
	netDiag(reg, deps, "net_mtr", "对目标主机执行 mtr 路由质量探测。", nettools.ToolMTR)

	nodeWriteTool(reg, "net_set_iface",
		"启用/禁用某个网络接口(ip link up/down)。高危操作，需审批。",
		auth.PermNetworkManage, "切换网络接口状态",
		objSchema(nodeIDProp+`,"name":{"type":"string","description":"接口名，如 eth0"},"up":{"type":"boolean","description":"true=启用，false=禁用"}`, "node_id", "name", "up"),
		func(ctx context.Context, t tools.ToolCtx, raw json.RawMessage, nid uint64) (string, error) {
			var a struct {
				Name string `json:"name"`
				Up   bool   `json:"up"`
			}
			if err := json.Unmarshal(raw, &a); err != nil || a.Name == "" {
				return "", fmt.Errorf("name required")
			}
			if err := deps.NetTools.SetIface(ctx, t.UserID, nid, nettoolsClaims(t), a.Name, a.Up); err != nil {
				return "", err
			}
			state := "禁用"
			if a.Up {
				state = "启用"
			}
			return fmt.Sprintf("已在节点 %d %s接口 %s", nid, state, a.Name), nil
		})
}

func netDiag(reg *tools.Registry, deps Deps, name, desc string, tool nettools.DiagTool) {
	nodeReadTool(reg, name, desc,
		objSchema(nodeIDProp+`,"target":{"type":"string","description":"目标主机名 / IP / 域名"}`, "node_id", "target"),
		func(ctx context.Context, t tools.ToolCtx, raw json.RawMessage, nid uint64) (string, error) {
			target, err := strArg(raw, "target")
			if err != nil {
				return "", err
			}
			res, err := deps.NetTools.Diagnose(ctx, t.UserID, nid, tool, target)
			if err != nil {
				return "", err
			}
			return view("net_diag", res)
		})
}
