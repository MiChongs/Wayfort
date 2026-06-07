// Package logs reads system logs from a managed Linux node over SSH — both
// journald (per-unit) and plain files under /var/log — with one-shot tail and a
// cancellable streaming follow (driven over SSE by the handler). Read-only,
// gated by ActionConnect.
package logs

import (
	"errors"
	"time"
)

// LogFile is one candidate log file with size + mtime for the picker.
type LogFile struct {
	Path     string `json:"path"`
	SizeKb   int64  `json:"size_kb"`
	Modified string `json:"modified,omitempty"`
}

// LogList enumerates readable log sources on the node.
type LogList struct {
	HasJournal bool      `json:"has_journal"`
	Files      []LogFile `json:"files"`
	SampledAt  time.Time `json:"sampled_at"`
}

// LogTail is a one-shot tail of a journald unit or a file.
type LogTail struct {
	Source    string    `json:"source"` // journal | file
	Ref       string    `json:"ref"`    // unit name or file path
	Lines     int       `json:"lines"`
	Text      string    `json:"text"`
	SampledAt time.Time `json:"sampled_at"`
}

var (
	ErrDisabled     = errors.New("logs: disabled by config")
	ErrUnauthorized = errors.New("logs: not authorised on node")
	ErrUnreachable  = errors.New("logs: node unreachable over ssh")
	ErrBadRef       = errors.New("logs: invalid unit or path")
	ErrBadSource    = errors.New("logs: source must be journal or file")
)
