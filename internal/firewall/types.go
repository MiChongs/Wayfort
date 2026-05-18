// Package firewall reads + mutates the host firewall (ufw / firewalld /
// iptables) over an SSH session, presenting a unified Rule model to callers.
//
// Read operations require ActionConnect on the node; writes are gated by the
// `firewall:manage` permission and audited.
package firewall

import "time"

// Tool identifies which firewall front-end is in use on the node. The
// detector picks the first one available in this order: ufw → firewalld →
// iptables. If none are present the manager returns ToolUnsupported.
type Tool string

const (
	ToolUFW         Tool = "ufw"
	ToolFirewalld   Tool = "firewalld"
	ToolIPTables    Tool = "iptables"
	ToolUnsupported Tool = ""
)

// Status describes the firewall's current high-level state.
type Status struct {
	Tool      Tool      `json:"tool"`
	Active    bool      `json:"active"`
	Policy    string    `json:"policy,omitempty"`     // INPUT chain default (iptables) / "deny / allow" (ufw)
	RuleCount int       `json:"rule_count"`
	Reason    string    `json:"reason,omitempty"`     // populated when Tool=="" — operator hint
	SampledAt time.Time `json:"sampled_at"`
}

// Rule is the unified form across tools. Index is the row number used to
// delete the rule (ufw / iptables uses positional; firewalld uses zone +
// service/port descriptors, mapped onto Index in display order).
type Rule struct {
	Index     int    `json:"index"`
	Action    string `json:"action"`             // ALLOW | DENY | REJECT
	Direction string `json:"direction"`          // in | out
	Protocol  string `json:"protocol,omitempty"` // tcp | udp | icmp | any
	Port      string `json:"port,omitempty"`     // "22" | "80,443" | "" (any)
	Source    string `json:"source,omitempty"`   // CIDR or "Anywhere"
	Raw       string `json:"raw"`                // original line — caller can copy/paste
}

// RuleSpec is the create-rule input. Matches the ufw add/iptables append
// vocabulary; the manager translates to the specific tool's syntax.
type RuleSpec struct {
	Action    string `json:"action" binding:"required"` // ALLOW | DENY | REJECT
	Direction string `json:"direction"`                 // in | out — default "in"
	Protocol  string `json:"protocol"`                  // tcp | udp — default "tcp"
	Port      string `json:"port" binding:"required"`   // "22" or "80:90"
	Source    string `json:"source"`                    // CIDR; empty = anywhere
}
