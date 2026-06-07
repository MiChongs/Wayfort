// Package storage inspects and manages block storage on a managed Linux node
// over SSH: lsblk topology, filesystem usage (capacity + inodes), fstab, SMART
// health and LVM. Reads require ActionConnect; mount/umount are gated by
// `storage:manage` and audited.
package storage

import (
	"errors"
	"time"
)

// BlockDevice is one lsblk node (disks contain partition/lv children).
type BlockDevice struct {
	Name       string        `json:"name"`
	Type       string        `json:"type"`
	Size       string        `json:"size"`
	FSType     string        `json:"fstype,omitempty"`
	MountPoint string        `json:"mountpoint,omitempty"`
	Model      string        `json:"model,omitempty"`
	Children   []BlockDevice `json:"children,omitempty"`
}

// Filesystem is one mounted filesystem with capacity + inode usage.
type Filesystem struct {
	Source   string `json:"source"`
	FSType   string `json:"fstype,omitempty"`
	Mount    string `json:"mount"`
	SizeKb   int64  `json:"size_kb"`
	UsedKb   int64  `json:"used_kb"`
	AvailKb  int64  `json:"avail_kb"`
	UsePct   int    `json:"use_pct"`
	InodePct int    `json:"inode_pct"`
}

// FstabEntry is one parsed /etc/fstab row.
type FstabEntry struct {
	Spec    string `json:"spec"`
	Mount   string `json:"mount"`
	FSType  string `json:"fstype"`
	Options string `json:"options"`
}

// SmartStatus is one disk's SMART overall-health verdict.
type SmartStatus struct {
	Device string `json:"device"`
	Health string `json:"health"` // PASSED | FAILED | unknown
}

// Info is the whole storage picture.
type Info struct {
	Devices     []BlockDevice `json:"devices"`
	Filesystems []Filesystem  `json:"filesystems"`
	Fstab       []FstabEntry  `json:"fstab,omitempty"`
	Smart       []SmartStatus `json:"smart,omitempty"`
	LVM         string        `json:"lvm,omitempty"` // raw pvs/vgs/lvs
	SampledAt   time.Time     `json:"sampled_at"`
}

// AuditClaims carries the acting principal for the audit log.
type AuditClaims struct {
	UserID   uint64
	Username string
	ClientIP string
}

var (
	ErrDisabled         = errors.New("storage: disabled by config")
	ErrUnauthorized     = errors.New("storage: not authorised on node")
	ErrUnreachable      = errors.New("storage: node unreachable over ssh")
	ErrPermissionDenied = errors.New("storage: operation requires root / sudo")
	ErrBadPath          = errors.New("storage: invalid mount target")
	ErrBusy             = errors.New("storage: target is busy")
)
