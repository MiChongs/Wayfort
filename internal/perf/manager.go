package perf

import (
	"context"
	"fmt"
	"strings"
	"sync"
	"time"

	"github.com/michongs/jumpserver-anonymous/internal/asset"
	"github.com/michongs/jumpserver-anonymous/internal/model"
	"github.com/michongs/jumpserver-anonymous/internal/repo"
	"github.com/michongs/jumpserver-anonymous/internal/sshrun"
	"go.uber.org/zap"
	"golang.org/x/sync/singleflight"
)

type Config struct {
	Enabled    bool
	CacheTTL   time.Duration // default 3s
	SSHTimeout time.Duration // default 15s — vmstat/iostat sample 1s twice
}

type Manager struct {
	cfg    Config
	logger *zap.Logger
	nodes  *repo.NodeRepo
	creds  *repo.CredentialRepo
	asset  *asset.Resolver
	deps   sshrun.Deps

	mu     sync.Mutex
	cache  map[uint64]*snapEntry
	flight singleflight.Group
}

type snapEntry struct {
	at   time.Time
	snap Snapshot
}

type Deps struct {
	Logger *zap.Logger
	Nodes  *repo.NodeRepo
	Creds  *repo.CredentialRepo
	Asset  *asset.Resolver
	SSH    sshrun.Deps
}

func NewManager(cfg Config, deps Deps) *Manager {
	if cfg.CacheTTL <= 0 {
		cfg.CacheTTL = 3 * time.Second
	}
	if cfg.SSHTimeout <= 0 {
		cfg.SSHTimeout = 15 * time.Second
	}
	m := &Manager{
		cfg: cfg, logger: deps.Logger, nodes: deps.Nodes, creds: deps.Creds,
		asset: deps.Asset, deps: deps.SSH, cache: map[uint64]*snapEntry{},
	}
	if m.logger != nil {
		m.logger.Info("perf subsystem ready", zap.Bool("enabled", cfg.Enabled))
	}
	return m
}

func (m *Manager) Enabled() bool { return m.cfg.Enabled }

func (m *Manager) Snapshot(ctx context.Context, userID, nodeID uint64) (*Snapshot, error) {
	loaded, err := m.gateAndLoad(ctx, userID, nodeID)
	if err != nil {
		return nil, err
	}
	m.mu.Lock()
	if c, ok := m.cache[nodeID]; ok && time.Since(c.at) < m.cfg.CacheTTL {
		snap := c.snap
		m.mu.Unlock()
		return &snap, nil
	}
	m.mu.Unlock()
	v, err, _ := m.flight.Do(fmt.Sprintf("snap:%d", nodeID), func() (any, error) {
		return m.collect(ctx, nodeID, loaded)
	})
	if err != nil {
		return nil, err
	}
	snap := v.(*Snapshot)
	return snap, nil
}

func (m *Manager) collect(ctx context.Context, nodeID uint64, l *nodeAndCred) (*Snapshot, error) {
	cctx, cancel := context.WithTimeout(ctx, m.cfg.SSHTimeout)
	defer cancel()
	res, err := sshrun.Run(cctx, m.deps, l.node, l.cred, snapshotScript, m.cfg.SSHTimeout)
	if err != nil && res.Stdout == "" {
		return nil, classifySSHError(err, res.Stderr, "perf snapshot")
	}
	sec := splitSections(res.Stdout)
	snap := Snapshot{GeneratedAt: time.Now().UTC()}
	snap.Load = parseLoad(sec["LOAD"])
	snap.Uptime = parseUptime(sec["UPTIME"])

	cpuSome, _, okc := parsePSI(sec["PSI_CPU"])
	ioSome, ioFull, oki := parsePSI(sec["PSI_IO"])
	memSome, memFull, okm := parsePSI(sec["PSI_MEM"])
	snap.Pressure = Pressure{
		Available: okc || oki || okm,
		CPUSome:   cpuSome, IOSome: ioSome, IOFull: ioFull, MemSome: memSome, MemFull: memFull,
	}
	snap.VMStat = parseVMStat(sec["VMSTAT"])
	snap.Disks = parseIOStat(sec["IOSTAT"])
	snap.SysstatAvailable = len(snap.Disks) > 0
	if !snap.SysstatAvailable {
		snap.Notes = "未检测到 sysstat（iostat）。磁盘 I/O 明细需 SSH 进去安装 sysstat。"
	}
	snap.DmesgTail, snap.OOMEvents = classifyDmesg(sec["DMESG"])

	m.mu.Lock()
	m.cache[nodeID] = &snapEntry{at: time.Now(), snap: snap}
	m.mu.Unlock()
	return &snap, nil
}

// Dmesg returns the kernel ring buffer tail.
func (m *Manager) Dmesg(ctx context.Context, userID, nodeID uint64, lines int) (*Dmesg, error) {
	loaded, err := m.gateAndLoad(ctx, userID, nodeID)
	if err != nil {
		return nil, err
	}
	if lines <= 0 || lines > 2000 {
		lines = 200
	}
	script := fmt.Sprintf("LC_ALL=C\n(dmesg -T 2>/dev/null || dmesg 2>/dev/null) | tail -%d", lines)
	cctx, cancel := context.WithTimeout(ctx, m.cfg.SSHTimeout)
	defer cancel()
	res, err := sshrun.Run(cctx, m.deps, loaded.node, loaded.cred, script, m.cfg.SSHTimeout)
	if err != nil && res.Stdout == "" {
		return nil, classifySSHError(err, res.Stderr, "dmesg")
	}
	return &Dmesg{Lines: splitNonEmptyLines(res.Stdout), SampledAt: time.Now().UTC()}, nil
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

func classifySSHError(err error, stderr, op string) error {
	if err == nil {
		return nil
	}
	e := strings.ToLower(err.Error())
	switch {
	case strings.Contains(e, "unable to authenticate") || strings.Contains(e, "no route to host") ||
		strings.Contains(e, "i/o timeout") || strings.Contains(e, "connection refused"):
		return fmt.Errorf("%w: %v (%s)", ErrUnreachable, err, op)
	default:
		return fmt.Errorf("%s: %w (stderr: %s)", op, err, truncate(stderr, 200))
	}
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
