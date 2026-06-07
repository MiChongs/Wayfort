// Package sysuser inspects and manages local accounts on a managed Linux node
// over SSH: users, groups, current logins and login history. Reads require
// ActionConnect; lock/unlock and group changes are gated by `sysuser:manage`
// and audited. User/group names are charset-validated.
package sysuser

import (
	"errors"
	"time"
)

type User struct {
	Name   string `json:"name"`
	UID    int    `json:"uid"`
	GID    int    `json:"gid"`
	Gecos  string `json:"gecos,omitempty"`
	Home   string `json:"home,omitempty"`
	Shell  string `json:"shell,omitempty"`
	System bool   `json:"system"` // uid < 1000
}

type Group struct {
	Name    string   `json:"name"`
	GID     int      `json:"gid"`
	Members []string `json:"members,omitempty"`
}

type LoginSession struct {
	User  string `json:"user"`
	TTY   string `json:"tty"`
	From  string `json:"from,omitempty"`
	Login string `json:"login,omitempty"`
}

type LoginHistory struct {
	User   string `json:"user"`
	From   string `json:"from,omitempty"`
	When   string `json:"when,omitempty"`
	Failed bool   `json:"failed,omitempty"`
}

type Info struct {
	Users     []User         `json:"users"`
	Groups    []Group        `json:"groups"`
	Online    []LoginSession `json:"online"`
	Recent    []LoginHistory `json:"recent,omitempty"`
	Sudoers   []string       `json:"sudoers,omitempty"`
	SampledAt time.Time      `json:"sampled_at"`
}

type AuditClaims struct {
	UserID   uint64
	Username string
	ClientIP string
}

var (
	ErrDisabled         = errors.New("sysuser: disabled by config")
	ErrUnauthorized     = errors.New("sysuser: not authorised on node")
	ErrUnreachable      = errors.New("sysuser: node unreachable over ssh")
	ErrPermissionDenied = errors.New("sysuser: operation requires root / sudo")
	ErrBadName          = errors.New("sysuser: invalid user or group name")
)
