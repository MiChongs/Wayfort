package model

import (
	"slices"
	"strings"
	"time"
)

type AuditEventKind string

const (
	AuditSessionStart     AuditEventKind = "session.start"
	AuditSessionEnd       AuditEventKind = "session.end"
	AuditSessionTerminate AuditEventKind = "session.terminate"
	AuditCommand          AuditEventKind = "command"
	AuditResize           AuditEventKind = "resize"
	AuditFileUpload       AuditEventKind = "file.upload"
	AuditFileDownload     AuditEventKind = "file.download"
	AuditFileDelete       AuditEventKind = "file.delete"
	AuditFileRename       AuditEventKind = "file.rename"
	AuditFileChmod        AuditEventKind = "file.chmod"
	AuditFileMkdir        AuditEventKind = "file.mkdir"
	AuditFileWrite        AuditEventKind = "file.write"
	AuditLogin            AuditEventKind = "auth.login"
	AuditLoginFailed      AuditEventKind = "auth.login_failed"
	AuditAnonymousLaunch  AuditEventKind = "anonymous.launch"
	AuditAnonymousReap    AuditEventKind = "anonymous.reap"
	AuditPortForwardOpen  AuditEventKind = "portforward.open"
	AuditPortForwardClose AuditEventKind = "portforward.close"
	AuditGraphicalStart   AuditEventKind = "graphical.start"
	AuditGraphicalError   AuditEventKind = "graphical.error"
	// Lifecycle v3 — fine-grained connection stages and reconnects. session.phase
	// carries "phase=<kind> status=<status>" in its payload; a failed phase is
	// treated as abnormal (see IsAbnormal).
	AuditSessionPhase     AuditEventKind = "session.phase"
	AuditSessionReconnect AuditEventKind = "session.reconnect"
	// session.observe is written whenever an admin starts/stops read-only live
	// watching of an in-progress session — always recorded for compliance.
	AuditSessionObserve AuditEventKind = "session.observe"
	// Graphical interaction audit — clipboard / file-transfer / window-resize
	// events lifted out of the binary .dtr tape so they are text-searchable in
	// the audit center. Payloads carry metadata only, never clipboard contents.
	AuditGraphicalClipboard AuditEventKind = "graphical.clipboard"
	AuditGraphicalFile      AuditEventKind = "graphical.file"
	AuditGraphicalResize    AuditEventKind = "graphical.resize"
	// Plan v2 — server-management actions executed via SSH.
	AuditFirewallChange AuditEventKind = "firewall.change"
	AuditDockerAction   AuditEventKind = "docker.action"
	AuditServiceAction  AuditEventKind = "service.action"
	AuditProcessAction  AuditEventKind = "process.action"
	AuditCronChange     AuditEventKind = "cron.change"
	AuditPackageAction  AuditEventKind = "package.action"
	AuditStorageAction  AuditEventKind = "storage.action"
	AuditKernelChange   AuditEventKind = "kernel.change"
	AuditSysUserAction  AuditEventKind = "sysuser.action"
	AuditNetworkAction  AuditEventKind = "network.action"
	AuditSecurityAction AuditEventKind = "security.action"
	// Object-storage (OSS) bastion operations.
	AuditOSSList     AuditEventKind = "oss.list"
	AuditOSSDownload AuditEventKind = "oss.download"
	AuditOSSUpload   AuditEventKind = "oss.upload"
	AuditOSSDelete   AuditEventKind = "oss.delete"
	AuditOSSMkdir    AuditEventKind = "oss.mkdir"
	AuditOSSCopy     AuditEventKind = "oss.copy"
	// Authentication outcomes — emitted by the login flow so the audit center
	// has a populated 认证 lane (previously these constants were defined but
	// never written).
	// (AuditLogin / AuditLoginFailed are declared above with the session block.)

	// Governance — approval decisions and runtime configuration edits.
	AuditApprovalRequest AuditEventKind = "approval.request"
	AuditApprovalDecide  AuditEventKind = "approval.decide"
	AuditApprovalRevoke  AuditEventKind = "approval.revoke"
	AuditConfigChange    AuditEventKind = "config.change"
)

type AuditLog struct {
	ID        uint64         `gorm:"primaryKey" json:"id"`
	Kind      AuditEventKind `gorm:"size:64;index" json:"kind"`
	UserID    uint64         `gorm:"index" json:"user_id"`
	Username  string         `gorm:"size:64" json:"username"`
	SessionID string         `gorm:"size:64;index" json:"session_id,omitempty"`
	NodeID    *uint64        `json:"node_id,omitempty"`
	ClientIP  string         `gorm:"size:64" json:"client_ip"`
	Payload   string         `gorm:"type:text" json:"payload,omitempty"`
	CreatedAt time.Time      `gorm:"index" json:"created_at"`
}

func (AuditLog) TableName() string { return "audit_logs" }

// ----- Taxonomy: categories, abnormal detection -----
//
// The audit center groups 47 raw kinds into six human lanes. This mapping is
// the single backend source of truth; the web UI carries an equivalent copy in
// session-meta.tsx. Keep them in lockstep.

// Audit category identifiers shared by the stats aggregation and the list
// filter so the segmented control and the composition chart agree.
const (
	AuditCatSession = "session"
	AuditCatCommand = "command"
	AuditCatFile    = "file"
	AuditCatAuth    = "auth"
	AuditCatOps     = "ops"
	AuditCatOSS     = "oss"
)

// AuditCategories is the ordered lane list the UI renders as filter segments.
var AuditCategories = []string{
	AuditCatSession, AuditCatCommand, AuditCatFile,
	AuditCatAuth, AuditCatOps, AuditCatOSS,
}

// auditCategoryKinds maps each lane to the raw kinds it absorbs. Governance
// events (approval / config) fold into ops so we keep exactly six lanes.
var auditCategoryKinds = map[string][]string{
	AuditCatSession: {
		string(AuditSessionStart), string(AuditSessionEnd), string(AuditSessionTerminate),
		string(AuditResize), string(AuditGraphicalStart), string(AuditGraphicalError),
		string(AuditAnonymousLaunch), string(AuditAnonymousReap),
		string(AuditPortForwardOpen), string(AuditPortForwardClose),
		// Lifecycle v3 — phases, reconnects, observe, and graphical interaction
		// all fold into the session lane to keep exactly six lanes (the web
		// session-meta.tsx copy must stay in lockstep).
		string(AuditSessionPhase), string(AuditSessionReconnect), string(AuditSessionObserve),
		string(AuditGraphicalClipboard), string(AuditGraphicalFile), string(AuditGraphicalResize),
	},
	AuditCatCommand: {string(AuditCommand)},
	AuditCatFile: {
		string(AuditFileUpload), string(AuditFileDownload), string(AuditFileDelete),
		string(AuditFileRename), string(AuditFileChmod), string(AuditFileMkdir), string(AuditFileWrite),
	},
	AuditCatAuth: {string(AuditLogin), string(AuditLoginFailed)},
	AuditCatOps: {
		string(AuditFirewallChange), string(AuditDockerAction), string(AuditServiceAction),
		string(AuditProcessAction), string(AuditCronChange), string(AuditPackageAction),
		string(AuditStorageAction), string(AuditKernelChange), string(AuditSysUserAction),
		string(AuditNetworkAction), string(AuditSecurityAction),
		string(AuditApprovalRequest), string(AuditApprovalDecide), string(AuditApprovalRevoke),
		string(AuditConfigChange),
	},
	AuditCatOSS: {
		string(AuditOSSList), string(AuditOSSDownload), string(AuditOSSUpload),
		string(AuditOSSDelete), string(AuditOSSMkdir), string(AuditOSSCopy),
	},
}

var auditKindCategory = func() map[string]string {
	m := make(map[string]string, 48)
	for cat, kinds := range auditCategoryKinds {
		for _, k := range kinds {
			m[k] = cat
		}
	}
	return m
}()

// AuditKindsForCategory returns the raw kinds a lane absorbs (nil for unknown).
func AuditKindsForCategory(cat string) []string { return auditCategoryKinds[cat] }

// AuditCategoryOf classifies a kind into its lane, defaulting to ops for any
// unmapped/future kind so it still surfaces rather than vanishing.
func AuditCategoryOf(kind string) string {
	if c, ok := auditKindCategory[kind]; ok {
		return c
	}
	return AuditCatOps
}

// AuditAbnormalKinds are the kinds that are noteworthy on their own — failures,
// errors, destructive deletes, and admin force-offs. The list backs both the
// per-row severity tag and the SQL predicate behind the "仅异常" filter.
var AuditAbnormalKinds = []string{
	string(AuditLoginFailed), string(AuditGraphicalError), string(AuditSessionTerminate),
	string(AuditFileDelete), string(AuditOSSDelete),
}

// AuditDangerousCommandMarkers flag a command line as high-risk by substring.
// Kept deliberately conservative — these are markers operators would want
// flagged in red, not a full shell parser.
var AuditDangerousCommandMarkers = []string{
	"rm -rf", "rm -fr", "rm -r -f", "mkfs", "dd if=", "dd of=/dev/",
	":(){", "shutdown", "reboot", "init 0", "init 6", "halt",
	"> /dev/sd", "chmod -R 777 /", "chown -R", "drop database", "drop table",
	"truncate table", "> /dev/null 2>&1 &", "iptables -F", "userdel", "passwd ",
}

func containsAny(s string, markers []string) bool {
	for _, m := range markers {
		if strings.Contains(s, m) {
			return true
		}
	}
	return false
}

// IsAbnormal reports whether one event should be highlighted as abnormal. A
// command is abnormal only when its payload trips a dangerous marker.
func (a AuditLog) IsAbnormal() bool {
	if slices.Contains(AuditAbnormalKinds, string(a.Kind)) {
		return true
	}
	if a.Kind == AuditCommand {
		return containsAny(strings.ToLower(a.Payload), AuditDangerousCommandMarkers)
	}
	// A connection stage that failed (dial/auth/handshake refused, etc.) is
	// noteworthy on its own — surface it in the "仅异常" filter.
	if a.Kind == AuditSessionPhase {
		return strings.Contains(a.Payload, PhaseFailedMarker)
	}
	return false
}

// PhaseFailedMarker is the substring embedded in a session.phase payload when
// the stage failed. Kept as a shared constant so the audit_repo SQL predicate
// (a LIKE on this string) and the Go IsAbnormal check can never drift.
const PhaseFailedMarker = "status=failed"
