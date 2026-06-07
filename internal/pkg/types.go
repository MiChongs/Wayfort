// Package pkg manages OS packages on a managed Linux node over SSH across apt /
// dnf / yum / apk / zypper. Reads require ActionConnect; install/remove/upgrade
// are gated by `package:manage` and audited. Package names are charset-validated
// and shell-quoted; the package manager is auto-detected.
package pkg

import (
	"errors"
	"time"
)

// Manager kind detected on the node.
type Kind string

const (
	KindApt    Kind = "apt"
	KindDnf    Kind = "dnf"
	KindYum    Kind = "yum"
	KindApk    Kind = "apk"
	KindZypper Kind = "zypper"
	KindNone   Kind = ""
)

// Status is the high-level package picture.
type Status struct {
	Manager        Kind      `json:"manager"`
	Available      bool      `json:"available"`
	InstalledCount int       `json:"installed_count"`
	UpgradableCount int      `json:"upgradable_count"`
	SecurityCount  int       `json:"security_count"`
	Reason         string    `json:"reason,omitempty"`
	SampledAt      time.Time `json:"sampled_at"`
}

// Update is one upgradable package.
type Update struct {
	Name      string `json:"name"`
	Current   string `json:"current,omitempty"`
	Candidate string `json:"candidate,omitempty"`
	Security  bool   `json:"security,omitempty"`
}

// Pkg is one search hit.
type Pkg struct {
	Name      string `json:"name"`
	Version   string `json:"version,omitempty"`
	Installed bool   `json:"installed"`
	Summary   string `json:"summary,omitempty"`
}

// ActionResult carries the captured output of a write op (these can be chatty).
type ActionResult struct {
	OK     bool   `json:"ok"`
	Output string `json:"output"`
}

// Verb is a whitelisted package action.
type Verb string

const (
	VerbInstall    Verb = "install"
	VerbRemove     Verb = "remove"
	VerbUpgrade    Verb = "upgrade"      // upgrade one package
	VerbUpgradeAll Verb = "upgrade-all"  // upgrade everything
	VerbUpdate     Verb = "update"       // refresh package index
)

func ValidVerb(v Verb) bool {
	switch v {
	case VerbInstall, VerbRemove, VerbUpgrade, VerbUpgradeAll, VerbUpdate:
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
	ErrDisabled         = errors.New("pkg: disabled by config")
	ErrUnauthorized     = errors.New("pkg: not authorised on node")
	ErrUnreachable      = errors.New("pkg: node unreachable over ssh")
	ErrPermissionDenied = errors.New("pkg: operation requires root / sudo")
	ErrNoManager        = errors.New("pkg: no supported package manager found")
	ErrBadName          = errors.New("pkg: invalid package name")
	ErrBadVerb          = errors.New("pkg: unsupported action")
)
