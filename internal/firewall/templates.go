package firewall

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"fmt"
	"strconv"
	"strings"
	"time"
)

// templates.go holds the static catalogue (service/port presets + policy
// templates) and the export/import ruleset surface. Templates and imports are
// high-risk (they change the default posture / replace the whole ruleset) and
// are always applied through the safe-apply + auto-rollback flow (safeapply.go).

// PortPresets is the one-click service catalogue surfaced in the rule form.
var PortPresets = []PortPreset{
	{"ssh", "SSH", "22", "tcp", "remote"},
	{"http", "HTTP", "80", "tcp", "web"},
	{"https", "HTTPS", "443", "tcp", "web"},
	{"dns-udp", "DNS (UDP)", "53", "udp", "infra"},
	{"dns-tcp", "DNS (TCP)", "53", "tcp", "infra"},
	{"smtp", "SMTP", "25", "tcp", "infra"},
	{"smtps", "SMTPS", "465", "tcp", "infra"},
	{"imaps", "IMAPS", "993", "tcp", "infra"},
	{"ntp", "NTP", "123", "udp", "infra"},
	{"mysql", "MySQL / MariaDB", "3306", "tcp", "db"},
	{"postgres", "PostgreSQL", "5432", "tcp", "db"},
	{"redis", "Redis", "6379", "tcp", "db"},
	{"mongodb", "MongoDB", "27017", "tcp", "db"},
	{"rdp", "RDP", "3389", "tcp", "remote"},
	{"vnc", "VNC", "5900", "tcp", "remote"},
	{"wireguard", "WireGuard", "51820", "udp", "infra"},
}

// Templates is the policy template gallery. All are high-risk (they set a
// default-deny posture) so they go through safe-apply.
var Templates = []Template{
	{
		ID: "web", Name: "Web 服务器", Description: "默认拒绝入站，放行 SSH + HTTP + HTTPS",
		Tags: []string{"web", "default-deny"}, DefaultPolicy: "deny", HighRisk: true,
		Allows: []RuleSpec{
			{Action: "ALLOW", Direction: "in", Protocol: "tcp", Port: "22"},
			{Action: "ALLOW", Direction: "in", Protocol: "tcp", Port: "80"},
			{Action: "ALLOW", Direction: "in", Protocol: "tcp", Port: "443"},
		},
	},
	{
		ID: "db", Name: "数据库服务器", Description: "默认拒绝入站，仅放行 SSH + 内网 DB 端口",
		Tags: []string{"db", "default-deny"}, DefaultPolicy: "deny", HighRisk: true,
		Allows: []RuleSpec{
			{Action: "ALLOW", Direction: "in", Protocol: "tcp", Port: "22"},
			{Action: "ALLOW", Direction: "in", Protocol: "tcp", Port: "3306", Source: "10.0.0.0/8"},
			{Action: "ALLOW", Direction: "in", Protocol: "tcp", Port: "5432", Source: "10.0.0.0/8"},
		},
	},
	{
		ID: "lockdown", Name: "锁定", Description: "默认拒绝入站，仅放行当前 SSH 端口",
		Tags: []string{"lockdown", "default-deny"}, DefaultPolicy: "deny", HighRisk: true,
		Allows: []RuleSpec{
			// Port filled with the node's actual SSH port at apply time.
			{Action: "ALLOW", Direction: "in", Protocol: "tcp", Port: ""},
		},
	},
}

func templateByID(id string) *Template {
	for i := range Templates {
		if Templates[i].ID == id {
			return &Templates[i]
		}
	}
	return nil
}

// ExportRuleset dumps the current ruleset for backup. Read-only.
func (m *Manager) ExportRuleset(ctx context.Context, userID, nodeID uint64) (*RulesetDump, error) {
	l, err := m.gateAndLoad(ctx, userID, nodeID)
	if err != nil {
		return nil, err
	}
	status, _, err := m.snapshot(ctx, userID, nodeID)
	if err != nil {
		return nil, err
	}
	var cmd, format string
	switch status.Tool {
	case ToolNftables:
		cmd, format = "nft list ruleset", "nft"
	case ToolUFW:
		cmd, format = "cat /etc/ufw/user.rules", "ufw-user-rules"
	default:
		cmd, format = "iptables-save", "iptables-save"
	}
	wrapped := fmt.Sprintf("sudo -n %s 2>/dev/null || %s 2>/dev/null", cmd, cmd)
	out, err := m.runFW(ctx, l, wrapped, "export ruleset", m.cfg.SSHTimeout)
	if err != nil {
		return nil, err
	}
	sum := sha256.Sum256([]byte(out))
	return &RulesetDump{
		Tool: status.Tool, Format: format, Content: out,
		SHA256: hex.EncodeToString(sum[:]), SampledAt: time.Now().UTC(),
	}, nil
}

// ImportPreview is a dry-run summary of an import (no side effects).
func (m *Manager) ImportPreview(ctx context.Context, userID, nodeID uint64, content string) (*ApplyPlan, error) {
	if _, err := m.gateAndLoad(ctx, userID, nodeID); err != nil {
		return nil, err
	}
	status, _, err := m.snapshot(ctx, userID, nodeID)
	if err != nil {
		return nil, err
	}
	lines := 0
	keepsSSH := strings.Contains(content, strconv.Itoa(status.SSHPort))
	for _, ln := range strings.Split(content, "\n") {
		if t := strings.TrimSpace(ln); t != "" && !strings.HasPrefix(t, "#") {
			lines++
		}
	}
	plan := &ApplyPlan{Adds: lines, HighRisk: true}
	plan.RiskReasons = append(plan.RiskReasons, "整套规则集替换：会覆盖当前所有规则")
	if !keepsSSH {
		plan.RiskReasons = append(plan.RiskReasons, fmt.Sprintf("导入内容未显式放行当前 SSH 端口 %d", status.SSHPort))
	}
	return plan, nil
}

// ---- command builders (used by safeapply.go) ----

// buildTemplateCommands turns a template into a list of shell commands for the
// detected tool. ufw gets full default-deny + allows; iptables gets policy +
// allows; nft applies the allows (changing nft default policy in place is
// involved and left out for safety).
func buildTemplateCommands(tpl *Template, tool Tool, sshPort int) []string {
	var cmds []string
	allows := make([]RuleSpec, 0, len(tpl.Allows))
	for _, a := range tpl.Allows {
		if a.Port == "" {
			a.Port = strconv.Itoa(sshPort) // lockdown SSH placeholder
		}
		allows = append(allows, a)
	}
	switch tool {
	case ToolUFW:
		if tpl.DefaultPolicy == "deny" {
			cmds = append(cmds, "ufw --force enable", "ufw default deny incoming", "ufw default allow outgoing")
		}
		for _, a := range allows {
			_ = sanitizeSpec(&a)
			cmds = append(cmds, "ufw "+ufwRuleBody(a))
		}
	case ToolIPTables:
		for _, a := range allows {
			_ = sanitizeSpec(&a)
			cmds = append(cmds, "iptables -A INPUT "+iptRuleBody(a))
		}
		if tpl.DefaultPolicy == "deny" {
			cmds = append(cmds, "iptables -P INPUT DROP")
		}
	case ToolNftables:
		for _, a := range allows {
			_ = sanitizeSpec(&a)
			cmds = append(cmds, "nft add rule inet filter input "+nftMatchers(a)+" counter "+nftVerdict(a.Action))
		}
	}
	return cmds
}

// buildImportCommand restores a full ruleset. content travels as a base64
// literal over stdin (never interpolated). Returns the command + a description.
func buildImportCommand(tool Tool, format, b64 string) string {
	switch {
	case format == "nft" || tool == ToolNftables:
		return fmt.Sprintf(`printf %%s %s | base64 -d > /tmp/jsfw-import.nft && nft -f /tmp/jsfw-import.nft; rc=$?; rm -f /tmp/jsfw-import.nft; exit $rc`, b64)
	case format == "iptables-save" || tool == ToolIPTables:
		return fmt.Sprintf(`printf %%s %s | base64 -d | iptables-restore`, b64)
	case tool == ToolUFW:
		return fmt.Sprintf(`printf %%s %s | base64 -d > /etc/ufw/user.rules && ufw reload`, b64)
	default:
		return ""
	}
}

func defaultDenyCmd(tool Tool) string {
	switch tool {
	case ToolUFW:
		return "ufw --force enable && ufw default deny incoming && ufw default allow outgoing"
	case ToolIPTables:
		return "iptables -P INPUT DROP"
	default:
		return ""
	}
}
