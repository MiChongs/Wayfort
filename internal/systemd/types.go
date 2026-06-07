// Package systemd reads and controls systemd service units on a managed Linux
// node over SSH, presenting a unified Unit model to the workspace ops dock.
//
// Read operations (status / list / show / journal) require ActionConnect on the
// node; mutations (start / stop / restart / reload / enable / disable) are gated
// by the `service:manage` permission and audited. Unit names are validated and
// shell-quoted before interpolation; verbs come from a fixed whitelist — there
// is no path for caller-controlled shell.
package systemd

import (
	"errors"
	"time"
)

// Status is the high-level systemd state of a node.
type Status struct {
	Available    bool      `json:"available"`     // systemctl present + usable
	State        string    `json:"state"`         // running / degraded / maintenance / ... (systemctl is-system-running)
	Version      string    `json:"version,omitempty"`
	TotalUnits   int       `json:"total_units"`   // loaded service units
	RunningUnits int       `json:"running_units"`
	FailedUnits  int       `json:"failed_units"`
	Reason       string    `json:"reason,omitempty"` // populated when Available=false — operator hint
	SampledAt    time.Time `json:"sampled_at"`
}

// Unit is one service unit, merged from `list-units` (live state) and
// `list-unit-files` (boot-time enablement).
type Unit struct {
	Name        string `json:"name"`        // e.g. "nginx.service"
	Description string `json:"description"`
	Load        string `json:"load"`        // loaded / not-found / masked / error
	Active      string `json:"active"`      // active / inactive / failed / activating ...
	Sub         string `json:"sub"`         // running / exited / dead / failed ...
	Enabled     string `json:"enabled"`     // enabled / disabled / static / masked / "" (unknown)
}

// Detail is the expanded view for one unit: selected `systemctl show`
// properties plus a tail of the unit journal.
type Detail struct {
	Unit        Unit              `json:"unit"`
	Properties  map[string]string `json:"properties"`         // curated subset of `systemctl show`
	MainPID     int               `json:"main_pid,omitempty"`
	MemoryBytes int64             `json:"memory_bytes,omitempty"`
	TasksCurrent int64            `json:"tasks_current,omitempty"`
	ActiveSince string            `json:"active_since,omitempty"`
	Journal     string            `json:"journal,omitempty"`  // recent journalctl -u <unit>
	SampledAt   time.Time         `json:"sampled_at"`
}

// Journal is a stand-alone tail of one unit's logs.
type Journal struct {
	Unit      string    `json:"unit"`
	Lines     int       `json:"lines"`
	Text      string    `json:"text"`
	SampledAt time.Time `json:"sampled_at"`
}

// AuditClaims carries the acting principal for the audit log on a mutation.
type AuditClaims struct {
	UserID   uint64
	Username string
	ClientIP string
}

// Verb is a whitelisted control action. No other value reaches the shell.
type Verb string

const (
	VerbStart   Verb = "start"
	VerbStop    Verb = "stop"
	VerbRestart Verb = "restart"
	VerbReload  Verb = "reload"
	VerbEnable  Verb = "enable"
	VerbDisable Verb = "disable"
)

// ValidVerb reports whether v is a recognised control verb.
func ValidVerb(v Verb) bool {
	switch v {
	case VerbStart, VerbStop, VerbRestart, VerbReload, VerbEnable, VerbDisable:
		return true
	}
	return false
}

// Sentinel errors → HTTP statuses + UI hints (mirrors the firewall package).
var (
	ErrDisabled         = errors.New("systemd: disabled by config")
	ErrUnauthorized     = errors.New("systemd: not authorised on node")
	ErrNoSystemd        = errors.New("systemd: systemctl not available on node")
	ErrPermissionDenied = errors.New("systemd: command requires elevated privileges (run as root or configure sudo NOPASSWD for systemctl)")
	ErrUnreachable      = errors.New("systemd: node unreachable over ssh")
	ErrBadUnit          = errors.New("systemd: invalid unit name")
	ErrBadVerb          = errors.New("systemd: unsupported action")
	ErrParse            = errors.New("systemd: failed to parse systemctl output")
)
