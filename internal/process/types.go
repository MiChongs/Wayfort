// Package process lists and controls processes on a managed Linux node over
// SSH. Reads (list / detail) require ActionConnect; mutations (signal / renice)
// are gated by `process:manage` and audited. PIDs are validated as integers and
// signals come from a fixed whitelist — no caller-controlled shell.
package process

import (
	"errors"
	"time"
)

// Process is one row of the live process table.
type Process struct {
	PID        int     `json:"pid"`
	PPID       int     `json:"ppid"`
	User       string  `json:"user"`
	CPUPct     float64 `json:"cpu_pct"`
	MemPct     float64 `json:"mem_pct"`
	RSSKb      int64   `json:"rss_kb"`
	VSZKb      int64   `json:"vsz_kb"`
	Threads    int     `json:"threads"`
	Nice       int     `json:"nice"`
	State      string  `json:"state"`
	ElapsedSec int64   `json:"elapsed_sec"`
	Comm       string  `json:"comm"`
	Args       string  `json:"args"`
}

// ProcessList is the sorted table returned by /process/list.
type ProcessList struct {
	GeneratedAt time.Time `json:"generated_at"`
	Total       int       `json:"total"`
	Processes   []Process `json:"processes"`
}

// Detail expands one PID: curated /proc/<pid>/status fields, resource limits,
// open-fd count, full cmdline, and io counters.
type Detail struct {
	PID       int               `json:"pid"`
	Status    map[string]string `json:"status"`            // curated /proc/<pid>/status
	Cmdline   string            `json:"cmdline,omitempty"` // NUL-joined argv
	Limits    string            `json:"limits,omitempty"`  // raw /proc/<pid>/limits
	FDCount   int               `json:"fd_count"`
	IORead    int64             `json:"io_read_bytes,omitempty"`
	IOWrite   int64             `json:"io_write_bytes,omitempty"`
	SampledAt time.Time         `json:"sampled_at"`
}

// Signal is a whitelisted POSIX signal name. No other value reaches the shell.
type Signal string

const (
	SigTERM Signal = "TERM"
	SigKILL Signal = "KILL"
	SigHUP  Signal = "HUP"
	SigINT  Signal = "INT"
	SigSTOP Signal = "STOP"
	SigCONT Signal = "CONT"
	SigUSR1 Signal = "USR1"
	SigUSR2 Signal = "USR2"
	SigQUIT Signal = "QUIT"
)

// ValidSignal reports whether s is a recognised signal name.
func ValidSignal(s Signal) bool {
	switch s {
	case SigTERM, SigKILL, SigHUP, SigINT, SigSTOP, SigCONT, SigUSR1, SigUSR2, SigQUIT:
		return true
	}
	return false
}

// AuditClaims carries the acting principal for the audit log.
type AuditClaims struct {
	UserID   uint64
	Username string
	ClientIP string
}

var (
	ErrDisabled         = errors.New("process: disabled by config")
	ErrUnauthorized     = errors.New("process: not authorised on node")
	ErrUnreachable      = errors.New("process: node unreachable over ssh")
	ErrPermissionDenied = errors.New("process: operation requires elevated privileges")
	ErrBadPID           = errors.New("process: invalid pid")
	ErrBadSignal        = errors.New("process: unsupported signal")
	ErrBadNice          = errors.New("process: nice must be between -20 and 19")
	ErrParse            = errors.New("process: failed to parse ps output")
)
