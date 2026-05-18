// Package firewall reads + mutates the host firewall (ufw / firewalld / nft /
// iptables / ip6tables) over an SSH session, presenting a unified Rule model
// to callers.
//
// Read operations require ActionConnect on the node; writes are gated by the
// `firewall:manage` permission and audited.
package firewall

import (
	"errors"
	"time"
)

// Tool identifies which firewall front-end is in use on the node. The
// detector picks the first available in this priority: ufw → firewalld →
// nft → iptables. If none are present the manager returns ToolUnsupported.
type Tool string

const (
	ToolUFW         Tool = "ufw"
	ToolFirewalld   Tool = "firewalld"
	ToolNftables    Tool = "nft"
	ToolIPTables    Tool = "iptables"
	ToolUnsupported Tool = ""
)

// Family — IP-version partition. Empty string when the tool doesn't make a
// distinction (ufw, firewalld). iptables-style rules are tagged "inet" or
// "inet6"; nftables surfaces the underlying family ("inet" / "ip" / "ip6"
// /"arp" / "bridge") — for our table we map to inet/inet6 only.
type Family string

const (
	FamilyAny  Family = ""
	FamilyV4   Family = "inet"
	FamilyV6   Family = "inet6"
)

// Status describes the firewall's current high-level state.
type Status struct {
	Tool      Tool      `json:"tool"`
	Active    bool      `json:"active"`
	Policy    string    `json:"policy,omitempty"` // INPUT chain default (iptables) / "deny / allow" (ufw)
	RuleCount int       `json:"rule_count"`
	Reason    string    `json:"reason,omitempty"` // populated when Tool=="" — operator hint
	SampledAt time.Time `json:"sampled_at"`
}

// Rule is the unified form across tools. Index is the row number used to
// delete the rule (ufw / iptables: positional; nft: handle; firewalld:
// mapped onto display order — DeleteRule by index is unsupported there).
type Rule struct {
	Index     int    `json:"index"`
	Action    string `json:"action"`             // ALLOW | DENY | REJECT
	Direction string `json:"direction"`          // in | out
	Protocol  string `json:"protocol,omitempty"` // tcp | udp | icmp | any
	Port      string `json:"port,omitempty"`     // "22" | "80,443" | "" (any)
	Source    string `json:"source,omitempty"`   // CIDR or "Anywhere"
	Chain     string `json:"chain,omitempty"`    // INPUT / FORWARD / OUTPUT (iptables) | nft chain name
	Family    Family `json:"family,omitempty"`   // inet / inet6 / "" (tool doesn't distinguish)
	Raw       string `json:"raw"`                // original line — caller can copy/paste
}

// RuleSpec is the create-rule input. Matches the ufw / iptables vocabulary;
// the manager translates to the specific tool's syntax.
type RuleSpec struct {
	Action    string `json:"action" binding:"required"` // ALLOW | DENY | REJECT
	Direction string `json:"direction"`                 // in | out — default "in"
	Protocol  string `json:"protocol"`                  // tcp | udp — default "tcp"
	Port      string `json:"port" binding:"required"`   // "22" or "80:90"
	Source    string `json:"source"`                    // CIDR; empty = anywhere
}

// Diagnostics is the read-only response of /firewall/diagnose. Surfaces
// exactly what the manager observed when probing the node, so operators
// can self-serve "why doesn't firewall work" questions without grep-ing
// the gateway log.
type Diagnostics struct {
	UID               int       `json:"uid"`
	IsRoot            bool      `json:"is_root"`
	SudoAvailable     bool      `json:"sudo_available"`
	SudoNopasswdTools []string  `json:"sudo_nopasswd_tools,omitempty"` // entries from `sudo -n -l` matching firewall binaries
	ToolsFound        []string  `json:"tools_found,omitempty"`         // "ufw=/usr/sbin/ufw" ...
	SelectedTool      Tool      `json:"selected_tool"`
	ProbeRaw          string    `json:"probe_raw"`           // verbatim probe stdout
	LastError         string    `json:"last_error,omitempty"`
	ElapsedMs         int64     `json:"elapsed_ms"`
	SampledAt         time.Time `json:"sampled_at"`
}

// Sentinel errors used to map manager failures onto HTTP statuses + render
// useful UI hints. Wrap them with %w when bubbling up additional context.
var (
	ErrDisabled         = errors.New("firewall: disabled by config")
	ErrUnauthorized     = errors.New("firewall: not authorised on node")
	ErrNoTool           = errors.New("firewall: no firewall front-end installed on node")
	ErrPermissionDenied = errors.New("firewall: command requires elevated privileges (run as root or configure sudo NOPASSWD)")
	ErrUnreachable      = errors.New("firewall: node unreachable over ssh")
	ErrParse            = errors.New("firewall: failed to parse tool output")
)
