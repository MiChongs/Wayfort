// Package hardware reports static hardware inventory from a managed Linux node
// over SSH (lscpu / lspci / lsusb / dmidecode / sensors). Read-only, gated by
// ActionConnect. dmidecode usually needs root — absent fields degrade quietly.
package hardware

import (
	"errors"
	"time"
)

// MemModule is one populated DIMM from `dmidecode -t memory`.
type MemModule struct {
	Locator string `json:"locator"`
	Size    string `json:"size"`
	Type    string `json:"type,omitempty"`
	Speed   string `json:"speed,omitempty"`
	Mfr     string `json:"manufacturer,omitempty"`
}

// Hardware is the whole inventory in one round-trip.
type Hardware struct {
	CPU        map[string]string `json:"cpu"`              // curated lscpu key→value
	BIOS       map[string]string `json:"bios"`             // curated dmidecode system/bios
	MemSummary string            `json:"mem_summary"`      // `free -h` mem line
	MemModules []MemModule       `json:"mem_modules,omitempty"`
	PCI        []string          `json:"pci,omitempty"`
	USB        []string          `json:"usb,omitempty"`
	Sensors    []string          `json:"sensors,omitempty"`
	Notes      string            `json:"notes,omitempty"`
	SampledAt  time.Time         `json:"sampled_at"`
}

var (
	ErrDisabled     = errors.New("hardware: disabled by config")
	ErrUnauthorized = errors.New("hardware: not authorised on node")
	ErrUnreachable  = errors.New("hardware: node unreachable over ssh")
)
