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
	Tool       Tool      `json:"tool"`
	Active     bool      `json:"active"`
	Installed  bool      `json:"installed"`            // a supported front-end is present
	Policy     string    `json:"policy,omitempty"`     // INPUT chain default (iptables) / "deny / allow" (ufw)
	DefaultIn  string    `json:"default_in,omitempty"` // ACCEPT | DROP | REJECT (best-effort)
	DefaultOut string    `json:"default_out,omitempty"`
	Chains     []string  `json:"chains,omitempty"`
	SSHPort    int       `json:"ssh_port,omitempty"` // the port we connected on (anti-lockout)
	RuleCount  int       `json:"rule_count"`
	Reason     string    `json:"reason,omitempty"` // populated when Tool=="" — operator hint
	SampledAt  time.Time `json:"sampled_at"`
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
	Handle    *int   `json:"handle,omitempty"`   // nft rule handle (edit/move/delete by handle)
	Table     string `json:"table,omitempty"`    // nft table (default filter)
	Comment   string `json:"comment,omitempty"`  // ufw/nft comment
	Pkts      int64  `json:"pkts,omitempty"`     // live hit counter (packets)
	Bytes     int64  `json:"bytes,omitempty"`    // live hit counter (bytes)
	Raw       string `json:"raw"`                // original line — caller can copy/paste
}

// Snapshot is the SSE payload: high-level status + the full rule list (with
// live counters) + optional exposure map + fail2ban summary. Status is embedded
// so its fields stay flat for the frontend.
type Snapshot struct {
	Status
	Rules    []Rule         `json:"rules"`
	Exposure []ExposurePort `json:"exposure,omitempty"`
	Fail2ban *F2BSummary    `json:"fail2ban,omitempty"`
}

type F2BSummary struct {
	Installed   bool `json:"installed"`
	BannedTotal int  `json:"banned_total"`
	JailCount   int  `json:"jail_count"`
}

// RuleInsert / RuleEdit / RuleMove are the ufw+nft first-class write inputs.
type RuleInsert struct {
	At   int      `json:"at" binding:"required"` // 1-based position
	Spec RuleSpec `json:"spec"`
}
type RuleEdit struct {
	Index   int      `json:"index"`            // ufw/iptables positional
	Handle  *int     `json:"handle,omitempty"` // nft handle
	Chain   string   `json:"chain,omitempty"`
	NewSpec RuleSpec `json:"new_spec"`
}
type RuleMove struct {
	From   int    `json:"from"`
	To     int    `json:"to"` // 1-based target
	Handle *int   `json:"handle,omitempty"`
	Chain  string `json:"chain,omitempty"`
}

// ExposureVerdict classifies a listening port against the firewall.
type ExposureVerdict string

const (
	ExposureOpen       ExposureVerdict = "open"       // reachable from 0.0.0.0/:: — danger
	ExposureRestricted ExposureVerdict = "restricted" // only allowed from specific sources
	ExposureBlocked    ExposureVerdict = "blocked"    // listening but firewalled off
	ExposureLocal      ExposureVerdict = "local"      // bound to loopback only
)

// ExposurePort is one listening socket cross-referenced with the firewall.
type ExposurePort struct {
	Proto       string          `json:"proto"` // tcp | udp
	Port        int             `json:"port"`
	ListenAddr  string          `json:"listen_addr"`
	Process     string          `json:"process,omitempty"`
	PID         int             `json:"pid,omitempty"`
	Verdict     ExposureVerdict `json:"verdict"`
	AllowedFrom []string        `json:"allowed_from,omitempty"`
	RuleIndex   int             `json:"rule_index,omitempty"`
}

// Conn is one active connection from conntrack.
type Conn struct {
	Proto string `json:"proto"`
	Src   string `json:"src"`
	SPort int    `json:"src_port,omitempty"`
	Dst   string `json:"dst"`
	DPort int    `json:"dst_port,omitempty"`
	State string `json:"state,omitempty"`
	Bytes int64  `json:"bytes,omitempty"`
	Pkts  int64  `json:"packets,omitempty"`
}
type ConntrackSnapshot struct {
	Total       int       `json:"total"`
	Truncated   bool      `json:"truncated"`
	Connections []Conn    `json:"connections"`
	SampledAt   time.Time `json:"sampled_at"`
}

// fail2ban
type F2BJail struct {
	Name      string   `json:"name"`
	Filter    string   `json:"filter,omitempty"`
	Banned    int      `json:"banned"`
	Total     int      `json:"total_failed,omitempty"`
	BannedIPs []string `json:"banned_ips,omitempty"`
}
type F2BStatus struct {
	Installed bool      `json:"installed"`
	Running   bool      `json:"running"`
	Jails     []F2BJail `json:"jails"`
	Reason    string    `json:"reason,omitempty"`
	SampledAt time.Time `json:"sampled_at"`
}

// FWProbe is the install pre-check response.
type FWProbe struct {
	OSID            string    `json:"os_id"`
	PkgManager      string    `json:"pkg_manager"`
	HasUFW          bool      `json:"has_ufw"`
	HasNft          bool      `json:"has_nft"`
	HasIptables     bool      `json:"has_iptables"`
	HasFirewalld    bool      `json:"has_firewalld"`
	HasFail2ban     bool      `json:"has_fail2ban"`
	HasConntrack    bool      `json:"has_conntrack"`
	CanSudo         bool      `json:"can_sudo"`
	RecommendedTool Tool      `json:"recommended_tool"`
	CmdPreviewUFW   string    `json:"cmd_preview_ufw"`
	CmdPreviewNft   string    `json:"cmd_preview_nft"`
	SampledAt       time.Time `json:"sampled_at"`
}

// PortPreset / Template are static catalogue entries (backend constants).
type PortPreset struct {
	ID       string `json:"id"`
	Name     string `json:"name"`
	Port     string `json:"port"`
	Protocol string `json:"protocol"`
	Category string `json:"category"`
}
type Template struct {
	ID            string     `json:"id"`
	Name          string     `json:"name"`
	Description   string     `json:"description,omitempty"`
	Tags          []string   `json:"tags,omitempty"`
	DefaultPolicy string     `json:"default_policy,omitempty"` // "deny" | ""
	Allows        []RuleSpec `json:"allows"`
	HighRisk      bool       `json:"high_risk"`
}

// RulesetDump is the export payload.
type RulesetDump struct {
	Tool      Tool      `json:"tool"`
	Format    string    `json:"format"` // iptables-save | nft | ufw-user-rules
	Content   string    `json:"content"`
	SHA256    string    `json:"sha256"`
	SampledAt time.Time `json:"sampled_at"`
}

// ApplyPlan / ApplyRequest / SafeApplyResult drive the safe-apply + auto-rollback flow.
type ApplyKind string

const (
	ApplyAdd      ApplyKind = "add"
	ApplyInsert   ApplyKind = "insert"
	ApplyDelete   ApplyKind = "delete"
	ApplyEdit     ApplyKind = "edit"
	ApplyReorder  ApplyKind = "reorder"
	ApplyBulk     ApplyKind = "bulk"
	ApplyImport   ApplyKind = "import"
	ApplyTemplate ApplyKind = "template"
	ApplyPolicy   ApplyKind = "policy"
)

type ApplyRequest struct {
	Kind         ApplyKind  `json:"kind"`
	Spec         *RuleSpec  `json:"spec,omitempty"`
	Insert       *RuleInsert `json:"insert,omitempty"`
	Edit         *RuleEdit  `json:"edit,omitempty"`
	Move         *RuleMove  `json:"move,omitempty"`
	Indexes      []int      `json:"indexes,omitempty"`
	TemplateID   string     `json:"template_id,omitempty"`
	Format       string     `json:"format,omitempty"`
	Content      string     `json:"content,omitempty"`
	DefaultPolicy string    `json:"default_policy,omitempty"`
	TTLSeconds   int        `json:"ttl_seconds,omitempty"`
	Confirm      bool       `json:"confirm"`
}

type ApplyPlan struct {
	Commands    []string `json:"commands"`
	Adds        int      `json:"adds"`
	Deletes     int      `json:"deletes"`
	HighRisk    bool     `json:"high_risk"`
	RiskReasons []string `json:"risk_reasons,omitempty"`
}

type SafeApplyResult struct {
	ArmToken    string    `json:"arm_token"`
	SnapshotID  string    `json:"snapshot_id"`
	ArmSeconds  int       `json:"window_seconds"`
	RollbackVia string    `json:"rollback_via"` // systemd-run | nohup | at
	JobRef      string    `json:"job_ref"`
	SSHGuard    string    `json:"ssh_guard"`
	Deadline    time.Time `json:"deadline"`
	HighRisk    bool      `json:"high_risk"`
	Plan        *ApplyPlan `json:"plan,omitempty"`
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

	ErrConfirmRequired = errors.New("firewall: destructive operation requires confirm=true")
	ErrAlreadyArmed    = errors.New("firewall: a rollback is already armed; commit or wait for it")
	ErrNoSnapshot      = errors.New("firewall: no pending rollback to commit")
	ErrEditUnsupported = errors.New("firewall: edit/reorder not supported for this tool")
	ErrSSHGuardFail    = errors.New("firewall: refused — would not preserve current SSH access")
	ErrBadSpec         = errors.New("firewall: invalid rule spec")
	ErrNotInstalled    = errors.New("firewall: tool present but not the requested one")
	ErrBadArg          = errors.New("firewall: invalid argument")
)
