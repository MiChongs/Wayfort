// Package kernel inspects and tunes kernel parameters on a managed Linux node
// over SSH: sysctl, loaded modules, ulimits and host identity. Reads require
// ActionConnect; sysctl writes are gated by `kernel:manage` and audited.
package kernel

import (
	"errors"
	"time"
)

// Sysctl is one kernel parameter.
type Sysctl struct {
	Key   string `json:"key"`
	Value string `json:"value"`
}

// Module is one loaded kernel module from lsmod.
type Module struct {
	Name   string `json:"name"`
	SizeKb int64  `json:"size_kb"`
	UsedBy string `json:"used_by,omitempty"`
}

// Info is the kernel/parameter snapshot.
type Info struct {
	Hostname  string    `json:"hostname"`
	Kernel    string    `json:"kernel"`
	OS        string    `json:"os"`
	Timezone  string    `json:"timezone,omitempty"`
	Sysctls   []Sysctl  `json:"sysctls"`
	Modules   []Module  `json:"modules"`
	Limits    string    `json:"limits,omitempty"` // raw `ulimit -a`
	SampledAt time.Time `json:"sampled_at"`
}

// AuditClaims carries the acting principal for the audit log.
type AuditClaims struct {
	UserID   uint64
	Username string
	ClientIP string
}

var (
	ErrDisabled         = errors.New("kernel: disabled by config")
	ErrUnauthorized     = errors.New("kernel: not authorised on node")
	ErrUnreachable      = errors.New("kernel: node unreachable over ssh")
	ErrPermissionDenied = errors.New("kernel: write requires root / sudo")
	ErrBadKey           = errors.New("kernel: invalid sysctl key")
	ErrBadValue         = errors.New("kernel: invalid sysctl value")
)
