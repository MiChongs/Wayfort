// Package cron inspects and edits scheduled tasks on a managed Linux node over
// SSH: the user crontab, system cron files, and systemd timers. Reads require
// ActionConnect; crontab edits + timer toggles are gated by `cron:manage` and
// audited. Crontab lines are validated + shell-quoted; timer names whitelisted.
package cron

import (
	"errors"
	"time"
)

// CronEntry is one user-crontab line.
type CronEntry struct {
	Index    int    `json:"index"` // 1-based line number for removal
	Schedule string `json:"schedule"`
	Command  string `json:"command"`
	Raw      string `json:"raw"`
}

// Timer is one systemd timer unit.
type Timer struct {
	Unit      string `json:"unit"`
	Next      string `json:"next,omitempty"`
	Left      string `json:"left,omitempty"`
	Activates string `json:"activates,omitempty"`
	Enabled   string `json:"enabled,omitempty"`
}

// Info is the scheduled-task snapshot.
type Info struct {
	UserCron   []CronEntry `json:"user_cron"`
	SystemCron []string    `json:"system_cron,omitempty"` // raw /etc/crontab + cron.d lines
	Timers     []Timer     `json:"timers,omitempty"`
	HasCrontab bool        `json:"has_crontab"`
	SampledAt  time.Time   `json:"sampled_at"`
}

type AuditClaims struct {
	UserID   uint64
	Username string
	ClientIP string
}

var (
	ErrDisabled         = errors.New("cron: disabled by config")
	ErrUnauthorized     = errors.New("cron: not authorised on node")
	ErrUnreachable      = errors.New("cron: node unreachable over ssh")
	ErrPermissionDenied = errors.New("cron: operation requires privileges")
	ErrBadEntry         = errors.New("cron: invalid crontab entry")
	ErrBadIndex         = errors.New("cron: invalid line index")
	ErrBadTimer         = errors.New("cron: invalid timer name")
)
