// Package loganalytics exposes a read-only log search + aggregation surface for
// the SSH ops dock: a cross-file / journald keyword (or regex) search that
// returns matching lines plus a severity histogram (error / warn / info), so an
// operator can triage without tailing. All over the pooled SSH connection;
// requires ActionConnect on the node (no writes, no extra permission).
package loganalytics

import (
	"context"
	"errors"
	"fmt"
	"strconv"
	"strings"
	"time"

	"github.com/michongs/jumpserver-anonymous/internal/asset"
	"github.com/michongs/jumpserver-anonymous/internal/model"
	"github.com/michongs/jumpserver-anonymous/internal/repo"
	"github.com/michongs/jumpserver-anonymous/internal/sshrun"
	"go.uber.org/zap"
)

var (
	ErrDisabled     = errors.New("loganalytics subsystem disabled")
	ErrUnauthorized = errors.New("not authorized for node")
	ErrUnreachable  = errors.New("node unreachable")
	ErrBadQuery     = errors.New("invalid query")
)

const maxMatches = 1000

type Config struct {
	Enabled    bool
	SSHTimeout time.Duration
}

type Deps struct {
	Logger *zap.Logger
	Nodes  *repo.NodeRepo
	Creds  *repo.CredentialRepo
	Asset  *asset.Resolver
	SSH    sshrun.Deps
}

type Match struct {
	Source string `json:"source"` // file path or journald unit
	Line   int    `json:"line"`
	Text   string `json:"text"`
	Level  string `json:"level"` // error | warn | info | other
}

type Levels struct {
	Error int `json:"error"`
	Warn  int `json:"warn"`
	Info  int `json:"info"`
	Other int `json:"other"`
}

type Result struct {
	Matches   []Match `json:"matches"`
	Levels    Levels  `json:"levels"`
	Truncated bool    `json:"truncated"`
	SampledAt time.Time `json:"sampled_at"`
}

// Query parameters. Source "files" greps `path` (a file or directory, recursive
// for a directory). Source "journal" runs journalctl, optionally for `unit`.
type Query struct {
	Source  string // "files" | "journal"
	Pattern string // grep -E pattern
	Path    string // for files
	Unit    string // for journal
	Lines   int    // journal lookback (n)
}

type Manager struct {
	cfg    Config
	logger *zap.Logger
	nodes  *repo.NodeRepo
	creds  *repo.CredentialRepo
	asset  *asset.Resolver
	deps   sshrun.Deps
}

func NewManager(cfg Config, deps Deps) *Manager {
	if cfg.SSHTimeout <= 0 {
		cfg.SSHTimeout = 30 * time.Second
	}
	m := &Manager{cfg: cfg, logger: deps.Logger, nodes: deps.Nodes, creds: deps.Creds, asset: deps.Asset, deps: deps.SSH}
	if m.logger != nil {
		m.logger.Info("loganalytics subsystem ready", zap.Bool("enabled", cfg.Enabled))
	}
	return m
}

func (m *Manager) Enabled() bool { return m.cfg.Enabled }

func (m *Manager) Search(ctx context.Context, userID, nodeID uint64, q Query) (*Result, error) {
	node, cred, err := m.gateAndLoad(ctx, userID, nodeID)
	if err != nil {
		return nil, err
	}
	pat := strings.TrimSpace(q.Pattern)
	if pat == "" || len(pat) > 512 || strings.ContainsAny(pat, "\n\r\x00") {
		return nil, ErrBadQuery
	}
	var script string
	if q.Source == "journal" {
		n := q.Lines
		if n <= 0 || n > 200000 {
			n = 20000
		}
		unit := ""
		if u := strings.TrimSpace(q.Unit); u != "" {
			if !validUnit(u) {
				return nil, ErrBadQuery
			}
			unit = "-u " + shellQuote(u)
		}
		// number lines after journalctl so we have a positional index
		script = fmt.Sprintf(`(sudo -n journalctl %s --no-pager -n %d 2>/dev/null || journalctl %s --no-pager -n %d 2>/dev/null) | grep -nE -m %d -- %s 2>/dev/null`,
			unit, n, unit, n, maxMatches, shellQuote(pat))
	} else {
		p := strings.TrimSpace(q.Path)
		if p == "" {
			p = "/var/log"
		}
		if !validPath(p) {
			return nil, ErrBadQuery
		}
		// -rnI: recurse, line numbers, skip binary. -m caps per-file; the head
		// caps the total. Filename:line:text on each row.
		script = fmt.Sprintf(`grep -rnIE -m %d -- %s %s 2>/dev/null | head -n %d`,
			maxMatches, shellQuote(pat), shellQuote(p), maxMatches)
	}
	cctx, cancel := context.WithTimeout(ctx, m.cfg.SSHTimeout)
	defer cancel()
	res, err := sshrun.Run(cctx, m.deps, node, cred, script, m.cfg.SSHTimeout)
	if err != nil && res.Stdout == "" {
		return nil, classify(err, "grep")
	}
	out := strings.TrimRight(res.Stdout, "\n")
	matches, levels := parseMatches(out, q.Source)
	return &Result{
		Matches:   matches,
		Levels:    levels,
		Truncated: len(matches) >= maxMatches,
		SampledAt: time.Now().UTC(),
	}, nil
}

func (m *Manager) gateAndLoad(ctx context.Context, userID, nodeID uint64) (*model.Node, *model.Credential, error) {
	if !m.cfg.Enabled {
		return nil, nil, ErrDisabled
	}
	if m.asset != nil {
		ok, err := m.asset.Check(ctx, userID, nodeID, asset.ActionConnect)
		if err != nil {
			return nil, nil, fmt.Errorf("asset check: %w", err)
		}
		if !ok {
			return nil, nil, ErrUnauthorized
		}
	}
	node, err := m.nodes.FindByID(ctx, nodeID)
	if err != nil || node == nil {
		return nil, nil, fmt.Errorf("node %d not found", nodeID)
	}
	if node.Disabled {
		return nil, nil, fmt.Errorf("node disabled")
	}
	cred, err := m.creds.FindByID(ctx, node.CredentialID)
	if err != nil || cred == nil {
		return nil, nil, fmt.Errorf("credential lookup failed")
	}
	return node, cred, nil
}

// parseMatches handles both `file:line:text` (files grep) and `line:text`
// (journald, numbered by grep -n) shapes, and tallies a severity histogram.
func parseMatches(raw, source string) ([]Match, Levels) {
	out := []Match{}
	lv := Levels{}
	for _, line := range strings.Split(raw, "\n") {
		line = strings.TrimRight(line, "\r")
		if line == "" {
			continue
		}
		var mt Match
		if source == "journal" {
			n, text, ok := splitOnce(line)
			if !ok {
				continue
			}
			mt = Match{Source: "journal", Line: atoi(n), Text: text}
		} else {
			file, rest, ok := splitOnce(line)
			if !ok {
				continue
			}
			n, text, ok2 := splitOnce(rest)
			if !ok2 {
				mt = Match{Source: file, Text: rest}
			} else {
				mt = Match{Source: file, Line: atoi(n), Text: text}
			}
		}
		mt.Level = levelOf(mt.Text)
		switch mt.Level {
		case "error":
			lv.Error++
		case "warn":
			lv.Warn++
		case "info":
			lv.Info++
		default:
			lv.Other++
		}
		out = append(out, mt)
	}
	return out, lv
}

func levelOf(text string) string {
	t := strings.ToLower(text)
	switch {
	case strings.Contains(t, "error") || strings.Contains(t, "err ") || strings.Contains(t, "fatal") ||
		strings.Contains(t, "panic") || strings.Contains(t, "critical") || strings.Contains(t, "fail"):
		return "error"
	case strings.Contains(t, "warn"):
		return "warn"
	case strings.Contains(t, "info") || strings.Contains(t, "notice"):
		return "info"
	default:
		return "other"
	}
}

func classify(err error, op string) error {
	if err == nil {
		return nil
	}
	e := strings.ToLower(err.Error())
	if strings.Contains(e, "unable to authenticate") || strings.Contains(e, "no route to host") ||
		strings.Contains(e, "i/o timeout") || strings.Contains(e, "connection refused") {
		return fmt.Errorf("%w: %v (%s)", ErrUnreachable, err, op)
	}
	return fmt.Errorf("%s: %w", op, err)
}

// splitOnce splits on the first colon.
func splitOnce(s string) (string, string, bool) {
	i := strings.IndexByte(s, ':')
	if i < 0 {
		return "", "", false
	}
	return s[:i], s[i+1:], true
}

func validPath(p string) bool {
	if p == "" || !strings.HasPrefix(p, "/") || len(p) > 4096 {
		return false
	}
	return !strings.ContainsAny(p, "\n\r\x00")
}

func validUnit(u string) bool {
	if len(u) > 128 {
		return false
	}
	for _, r := range u {
		if !(r >= 'a' && r <= 'z' || r >= 'A' && r <= 'Z' || r >= '0' && r <= '9' || r == '-' || r == '_' || r == '.' || r == '@' || r == ':') {
			return false
		}
	}
	return u != ""
}

func shellQuote(s string) string { return "'" + strings.ReplaceAll(s, "'", `'\''`) + "'" }

func atoi(s string) int {
	n, _ := strconv.Atoi(strings.TrimSpace(s))
	return n
}
