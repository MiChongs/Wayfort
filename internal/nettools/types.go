// Package nettools inspects networking on a managed Linux node over SSH
// (interfaces, routes, sockets) and runs network diagnostics (ping / traceroute
// / dig / curl / mtr). Reads + diagnostics require ActionConnect; bringing an
// interface up/down is gated by `network:manage` and audited.
package nettools

import (
	"errors"
	"time"
)

type Iface struct {
	Name  string   `json:"name"`
	MAC   string   `json:"mac,omitempty"`
	State string   `json:"state"`
	MTU   int      `json:"mtu,omitempty"`
	IPv4  []string `json:"ipv4,omitempty"`
	IPv6  []string `json:"ipv6,omitempty"`
}

type Route struct {
	Dst   string `json:"dst"`
	Via   string `json:"via,omitempty"`
	Dev   string `json:"dev,omitempty"`
	Proto string `json:"proto,omitempty"`
	Src   string `json:"src,omitempty"`
}

type Conn struct {
	Proto   string `json:"proto"`
	State   string `json:"state"`
	Local   string `json:"local"`
	Peer    string `json:"peer"`
	Process string `json:"process,omitempty"`
}

type Info struct {
	Ifaces    []Iface   `json:"ifaces"`
	Routes    []Route   `json:"routes"`
	Conns     []Conn    `json:"conns"`
	SampledAt time.Time `json:"sampled_at"`
}

// DiagResult is the captured output of one diagnostic run.
type DiagResult struct {
	Tool      string    `json:"tool"`
	Target    string    `json:"target"`
	Output    string    `json:"output"`
	SampledAt time.Time `json:"sampled_at"`
}

// DiagTool is a whitelisted diagnostic command.
type DiagTool string

const (
	ToolPing       DiagTool = "ping"
	ToolTraceroute DiagTool = "traceroute"
	ToolDig        DiagTool = "dig"
	ToolCurl       DiagTool = "curl"
	ToolMTR        DiagTool = "mtr"
)

func ValidTool(t DiagTool) bool {
	switch t {
	case ToolPing, ToolTraceroute, ToolDig, ToolCurl, ToolMTR:
		return true
	}
	return false
}

type AuditClaims struct {
	UserID   uint64
	Username string
	ClientIP string
}

var (
	ErrDisabled         = errors.New("nettools: disabled by config")
	ErrUnauthorized     = errors.New("nettools: not authorised on node")
	ErrUnreachable      = errors.New("nettools: node unreachable over ssh")
	ErrPermissionDenied = errors.New("nettools: operation requires root / sudo")
	ErrBadTool          = errors.New("nettools: unsupported tool")
	ErrBadTarget        = errors.New("nettools: invalid target")
	ErrBadIface         = errors.New("nettools: invalid interface name")
)
