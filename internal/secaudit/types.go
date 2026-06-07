// Package secaudit runs read-only security posture checks against a managed
// Linux node over SSH (SSH config, listening ports, SUID/world-writable files,
// fail2ban, failed logins, empty passwords) and scores them. Read-only — gated
// by ActionConnect. Remediation is surfaced as a copy-to-terminal command, never
// applied automatically.
package secaudit

import (
	"errors"
	"time"
)

// Status is a check verdict.
type Status string

const (
	StatusOK      Status = "ok"
	StatusWarn    Status = "warn"
	StatusDanger  Status = "danger"
	StatusInfo    Status = "info"
	StatusUnknown Status = "unknown"
)

// Check is one posture finding.
type Check struct {
	ID         string   `json:"id"`
	Category   string   `json:"category"`
	Title      string   `json:"title"`
	Status     Status   `json:"status"`
	Detail     string   `json:"detail,omitempty"`
	Items      []string `json:"items,omitempty"` // supporting evidence (files, ports…)
	Fix        string   `json:"fix,omitempty"`   // suggested command for "run in terminal"
	Applicable bool     `json:"applicable"`      // a safe blanket server-side fix exists (Apply)
}

// AuditClaims carries the acting principal for the audit log on Apply.
type AuditClaims struct {
	UserID   uint64
	Username string
	ClientIP string
}

// Report is the scored checklist.
type Report struct {
	Score     int       `json:"score"` // 0..100
	Checks    []Check   `json:"checks"`
	SampledAt time.Time `json:"sampled_at"`
}

var (
	ErrDisabled         = errors.New("secaudit: disabled by config")
	ErrUnauthorized     = errors.New("secaudit: not authorised on node")
	ErrUnreachable      = errors.New("secaudit: node unreachable over ssh")
	ErrPermissionDenied = errors.New("secaudit: fix requires root / sudo")
	ErrBadCheck         = errors.New("secaudit: unknown check")
	ErrNotApplicable    = errors.New("secaudit: this check has no automatic fix")
)
