package sysuser

import (
	"context"
	"fmt"
	"strings"
	"sync"
	"time"

	"github.com/michongs/jumpserver-anonymous/internal/asset"
	"github.com/michongs/jumpserver-anonymous/internal/audit"
	"github.com/michongs/jumpserver-anonymous/internal/model"
	"github.com/michongs/jumpserver-anonymous/internal/repo"
	"github.com/michongs/jumpserver-anonymous/internal/sshrun"
	"go.uber.org/zap"
	"golang.org/x/sync/singleflight"
)

type Config struct {
	Enabled    bool
	CacheTTL   time.Duration
	SSHTimeout time.Duration
}

type Manager struct {
	cfg    Config
	logger *zap.Logger
	nodes  *repo.NodeRepo
	creds  *repo.CredentialRepo
	asset  *asset.Resolver
	audit  *audit.Writer
	deps   sshrun.Deps

	mu     sync.Mutex
	cache  map[uint64]*entry
	flight singleflight.Group
}

type entry struct {
	at   time.Time
	info Info
}

type Deps struct {
	Logger *zap.Logger
	Nodes  *repo.NodeRepo
	Creds  *repo.CredentialRepo
	Asset  *asset.Resolver
	Audit  *audit.Writer
	SSH    sshrun.Deps
}

func NewManager(cfg Config, deps Deps) *Manager {
	if cfg.CacheTTL <= 0 {
		cfg.CacheTTL = 10 * time.Second
	}
	if cfg.SSHTimeout <= 0 {
		cfg.SSHTimeout = 10 * time.Second
	}
	m := &Manager{cfg: cfg, logger: deps.Logger, nodes: deps.Nodes, creds: deps.Creds, asset: deps.Asset, audit: deps.Audit, deps: deps.SSH, cache: map[uint64]*entry{}}
	if m.logger != nil {
		m.logger.Info("sysuser subsystem ready", zap.Bool("enabled", cfg.Enabled))
	}
	return m
}

func (m *Manager) Enabled() bool { return m.cfg.Enabled }

func (m *Manager) Info(ctx context.Context, userID, nodeID uint64) (*Info, error) {
	loaded, err := m.gateAndLoad(ctx, userID, nodeID)
	if err != nil {
		return nil, err
	}
	m.mu.Lock()
	if c, ok := m.cache[nodeID]; ok && time.Since(c.at) < m.cfg.CacheTTL {
		info := c.info
		m.mu.Unlock()
		return &info, nil
	}
	m.mu.Unlock()
	v, err, _ := m.flight.Do(fmt.Sprintf("user:%d", nodeID), func() (any, error) {
		return m.collect(ctx, nodeID, loaded)
	})
	if err != nil {
		return nil, err
	}
	return v.(*Info), nil
}

func (m *Manager) collect(ctx context.Context, nodeID uint64, l *nodeAndCred) (*Info, error) {
	cctx, cancel := context.WithTimeout(ctx, m.cfg.SSHTimeout)
	defer cancel()
	res, err := sshrun.Run(cctx, m.deps, l.node, l.cred, snapshotScript, m.cfg.SSHTimeout)
	if err != nil && res.Stdout == "" {
		return nil, classifySSHError(err, "user snapshot")
	}
	sec := splitSections(res.Stdout)
	info := Info{
		Users:     parsePasswd(sec["PASSWD"]),
		Groups:    parseGroup(sec["GROUP"]),
		Online:    parseWho(sec["WHO"]),
		Sudoers:   splitNonEmptyLines(sec["SUDOERS"]),
		SampledAt: time.Now().UTC(),
	}
	info.Recent = append(parseLast(sec["LAST"], false), parseLast(sec["LASTB"], true)...)
	m.mu.Lock()
	m.cache[nodeID] = &entry{at: time.Now(), info: info}
	m.mu.Unlock()
	return &info, nil
}

// SetLock locks/unlocks a local account.
func (m *Manager) SetLock(ctx context.Context, userID, nodeID uint64, claims AuditClaims, user string, lock bool) error {
	flag := "-U"
	verb := "unlock"
	if lock {
		flag = "-L"
		verb = "lock"
	}
	if !validName(user) {
		return ErrBadName
	}
	return m.write(ctx, userID, nodeID, claims, fmt.Sprintf("usermod %s %s 2>&1", flag, shellQuote(user)), fmt.Sprintf("%s user %s", verb, user))
}

// AddToGroup appends a user to a supplementary group.
func (m *Manager) AddToGroup(ctx context.Context, userID, nodeID uint64, claims AuditClaims, user, group string) error {
	if !validName(user) || !validName(group) {
		return ErrBadName
	}
	return m.write(ctx, userID, nodeID, claims, fmt.Sprintf("usermod -aG %s %s 2>&1", shellQuote(group), shellQuote(user)), fmt.Sprintf("add %s to group %s", user, group))
}

func (m *Manager) write(ctx context.Context, userID, nodeID uint64, claims AuditClaims, cmd, payload string) error {
	loaded, err := m.gateAndLoad(ctx, userID, nodeID)
	if err != nil {
		return err
	}
	cctx, cancel := context.WithTimeout(ctx, m.cfg.SSHTimeout)
	defer cancel()
	res, err := sshrun.Run(cctx, m.deps, loaded.node, loaded.cred, cmd, m.cfg.SSHTimeout)
	if err != nil {
		return classifyWrite(err, res.Stderr+res.Stdout, "usermod")
	}
	if e := classifyOutput(res.Stdout + " " + res.Stderr); e != nil {
		return e
	}
	m.mu.Lock()
	delete(m.cache, nodeID)
	m.mu.Unlock()
	m.recordAudit(claims, nodeID, payload)
	return nil
}

type nodeAndCred struct {
	node *model.Node
	cred *model.Credential
}

func (m *Manager) gateAndLoad(ctx context.Context, userID, nodeID uint64) (*nodeAndCred, error) {
	if !m.cfg.Enabled {
		return nil, ErrDisabled
	}
	if m.asset != nil {
		ok, err := m.asset.Check(ctx, userID, nodeID, asset.ActionConnect)
		if err != nil {
			return nil, fmt.Errorf("asset check: %w", err)
		}
		if !ok {
			return nil, ErrUnauthorized
		}
	}
	node, err := m.nodes.FindByID(ctx, nodeID)
	if err != nil || node == nil {
		return nil, fmt.Errorf("node %d not found", nodeID)
	}
	if node.Disabled {
		return nil, fmt.Errorf("node disabled")
	}
	cred, err := m.creds.FindByID(ctx, node.CredentialID)
	if err != nil || cred == nil {
		return nil, fmt.Errorf("credential lookup failed")
	}
	return &nodeAndCred{node: node, cred: cred}, nil
}

func (m *Manager) recordAudit(c AuditClaims, nodeID uint64, payload string) {
	if m.audit == nil {
		return
	}
	nid := nodeID
	m.audit.Log(model.AuditLog{Kind: model.AuditSysUserAction, UserID: c.UserID, Username: c.Username, NodeID: &nid, ClientIP: c.ClientIP, Payload: payload})
}

func classifySSHError(err error, op string) error {
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

func classifyWrite(err error, out, op string) error {
	if err == nil {
		return nil
	}
	if e := classifyOutput(out); e != nil {
		return e
	}
	return classifySSHError(err, op)
}

func classifyOutput(out string) error {
	low := strings.ToLower(out)
	if strings.Contains(low, "permission denied") || strings.Contains(low, "operation not permitted") ||
		strings.Contains(low, "not permitted") || strings.Contains(low, "you must be root") {
		return fmt.Errorf("%w: %s", ErrPermissionDenied, truncate(out, 160))
	}
	return nil
}

func splitSections(raw string) map[string]string {
	out := map[string]string{}
	cur := ""
	var buf strings.Builder
	for _, line := range strings.Split(raw, "\n") {
		t := strings.TrimRight(line, "\r")
		if strings.HasPrefix(t, "===") && strings.HasSuffix(t, "===") && len(t) > 6 {
			out[cur] = buf.String()
			cur = strings.Trim(t, "= ")
			buf.Reset()
			continue
		}
		buf.WriteString(t)
		buf.WriteByte('\n')
	}
	out[cur] = buf.String()
	delete(out, "END")
	return out
}

func truncate(s string, n int) string {
	if len(s) <= n {
		return s
	}
	return s[:n]
}
