package optools

import (
	"context"
	"encoding/json"
	"fmt"

	"github.com/michongs/wayfort/internal/ai/tools"
	"github.com/michongs/wayfort/internal/auth"
	"github.com/michongs/wayfort/internal/firewall"
)

func registerFirewallTools(reg *tools.Registry, deps Deps) {
	if deps.Firewall == nil {
		return
	}

	nodeReadTool(reg, "firewall_status",
		"获取节点防火墙状态（启用与否、使用的工具 ufw/firewalld/iptables/nft、默认策略、规则数）。",
		objSchema(nodeIDProp, "node_id"),
		func(ctx context.Context, t tools.ToolCtx, raw json.RawMessage, nid uint64) (string, error) {
			s, err := deps.Firewall.Status(ctx, t.UserID, nid)
			if err != nil {
				return "", err
			}
			return view("firewall_status", s)
		})

	nodeReadTool(reg, "firewall_list",
		"列出防火墙规则，返回方向、协议、端口、源、动作。",
		objSchema(nodeIDProp, "node_id"),
		func(ctx context.Context, t tools.ToolCtx, raw json.RawMessage, nid uint64) (string, error) {
			rules, err := deps.Firewall.ListRules(ctx, t.UserID, nid)
			if err != nil {
				return "", err
			}
			return view("firewall_rules", rules)
		})

	nodeReadTool(reg, "firewall_diagnose",
		"诊断为何防火墙操作可能失败（uid/sudo/可用工具探测），只读。",
		objSchema(nodeIDProp, "node_id"),
		func(ctx context.Context, t tools.ToolCtx, raw json.RawMessage, nid uint64) (string, error) {
			d, err := deps.Firewall.Diagnose(ctx, t.UserID, nid)
			if err != nil {
				return "", err
			}
			return view("firewall_diag", d)
		})

	nodeWriteTool(reg, "firewall_add",
		"新增一条防火墙规则。action=ALLOW/DENY/REJECT，direction=in/out，protocol=tcp/udp，port 如 22 或 80:90，source 为 CIDR(留空=任意)。高危操作，需审批。",
		auth.PermFirewallManage, "新增防火墙规则",
		objSchema(nodeIDProp+`,"action":{"type":"string","enum":["ALLOW","DENY","REJECT"]},"direction":{"type":"string","enum":["in","out"],"description":"默认 in"},"protocol":{"type":"string","enum":["tcp","udp"],"description":"默认 tcp"},"port":{"type":"string","description":"端口或区间，如 22 / 80:90"},"source":{"type":"string","description":"源 CIDR，留空为任意"}`, "node_id", "action", "port"),
		func(ctx context.Context, t tools.ToolCtx, raw json.RawMessage, nid uint64) (string, error) {
			var spec firewall.RuleSpec
			if err := json.Unmarshal(raw, &spec); err != nil || spec.Action == "" || spec.Port == "" {
				return "", fmt.Errorf("action and port required")
			}
			if err := deps.Firewall.AddRule(ctx, t.UserID, nid, firewallClaims(t), spec); err != nil {
				return "", err
			}
			return fmt.Sprintf("已在节点 %d 新增防火墙规则 %s %s/%s", nid, spec.Action, spec.Port, spec.Protocol), nil
		})

	nodeWriteTool(reg, "firewall_delete",
		"按序号删除一条防火墙规则（序号来自 firewall_list）。高危操作，需审批。",
		auth.PermFirewallManage, "删除防火墙规则",
		objSchema(nodeIDProp+`,"index":{"type":"integer","description":"规则序号"}`, "node_id", "index"),
		func(ctx context.Context, t tools.ToolCtx, raw json.RawMessage, nid uint64) (string, error) {
			var a struct {
				Index int `json:"index"`
			}
			if err := json.Unmarshal(raw, &a); err != nil {
				return "", err
			}
			if err := deps.Firewall.DeleteRule(ctx, t.UserID, nid, firewallClaims(t), a.Index); err != nil {
				return "", err
			}
			return fmt.Sprintf("已删除节点 %d 的防火墙规则 #%d", nid, a.Index), nil
		})

	nodeWriteTool(reg, "firewall_set_enabled",
		"启用或禁用整个防火墙。高危操作，需审批。",
		auth.PermFirewallManage, "切换防火墙开关",
		objSchema(nodeIDProp+`,"enabled":{"type":"boolean"}`, "node_id", "enabled"),
		func(ctx context.Context, t tools.ToolCtx, raw json.RawMessage, nid uint64) (string, error) {
			var a struct {
				Enabled bool `json:"enabled"`
			}
			if err := json.Unmarshal(raw, &a); err != nil {
				return "", err
			}
			if err := deps.Firewall.SetEnabled(ctx, t.UserID, nid, firewallClaims(t), a.Enabled); err != nil {
				return "", err
			}
			state := "禁用"
			if a.Enabled {
				state = "启用"
			}
			return fmt.Sprintf("已在节点 %d %s防火墙", nid, state), nil
		})
}
