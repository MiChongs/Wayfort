package insights

import (
	"context"
	"errors"
	"fmt"
	"sync"
	"sync/atomic"
	"time"

	"github.com/michongs/wayfort/internal/asset"
	"github.com/michongs/wayfort/internal/dialer"
	"github.com/michongs/wayfort/internal/domain"
	"github.com/michongs/wayfort/internal/model"
	"github.com/michongs/wayfort/internal/repo"
	pkgssh "github.com/michongs/wayfort/internal/ssh"
	"go.uber.org/zap"
	xssh "golang.org/x/crypto/ssh"
	"golang.org/x/sync/singleflight"
)

// Config knobs from the YAML. Each field has a sensible default if 0/unset.
type Config struct {
	Enabled       bool
	CacheTTL      time.Duration // server-side dedup of concurrent polls; default 3s.
	SSHTimeout    time.Duration // total time budget for a single sample; default 10s.
	ProcessLimit  int           // hard cap on processes returned; default 200.
}

// ErrUnauthorized is returned when the caller lacks ActionConnect on the node.
var ErrUnauthorized = errors.New("insights: not authorised on node")

// ErrDisabled when the feature is off in config.
var ErrDisabled = errors.New("insights: disabled by config")

// Manager runs SSH commands to collect system telemetry for a single node and
// caches the latest result. The cache is keyed by nodeID — all callers see
// the same data, which is fine for read-only telemetry.
type Manager struct {
	cfg     atomic.Pointer[Config] // live config; hot-swapped by ApplyConfig
	logger  *zap.Logger
	nodes   *repo.NodeRepo
	creds   *repo.CredentialRepo
	proxies *repo.ProxyRepo
	domains *domain.Resolver
	chain   *dialer.ChainBuilder
	resolver *pkgssh.Resolver
	hostKey xssh.HostKeyCallback
	asset   *asset.Resolver

	mu       sync.Mutex
	system   map[uint64]*systemCacheEntry
	procs    map[uint64]*procCacheEntry
	nets     map[uint64]*netCacheEntry
	// History for delta-based metrics (CPU usage_pct, per-iface bps).
	history  map[uint64]*nodeHistory

	flight singleflight.Group
}

type systemCacheEntry struct {
	at   time.Time
	snap SystemSnapshot
}
type procCacheEntry struct {
	at      time.Time
	sortBy  string
	list    ProcessList
}
type netCacheEntry struct {
	at   time.Time
	snap NetworkSnapshot
}

// nodeHistory carries the previous poll's cumulative counters used to compute
// rate metrics (CPU usage/breakdown/per-core, iface bandwidth, disk I/O).
// Protected by mu.
type nodeHistory struct {
	prev sampleState
}

// Deps groups the wiring values main.go passes us at startup.
type Deps struct {
	Logger   *zap.Logger
	Nodes    *repo.NodeRepo
	Creds    *repo.CredentialRepo
	Proxies  *repo.ProxyRepo
	Domains  *domain.Resolver
	Chain    *dialer.ChainBuilder
	Resolver *pkgssh.Resolver
	HostKey  xssh.HostKeyCallback
	Asset    *asset.Resolver
}

func normalize(cfg Config) Config {
	if cfg.CacheTTL <= 0 {
		cfg.CacheTTL = 3 * time.Second
	}
	if cfg.SSHTimeout <= 0 {
		cfg.SSHTimeout = 10 * time.Second
	}
	if cfg.ProcessLimit <= 0 {
		cfg.ProcessLimit = 200
	}
	return cfg
}

func NewManager(cfg Config, deps Deps) *Manager {
	m := &Manager{
		logger:   deps.Logger,
		nodes:    deps.Nodes,
		creds:    deps.Creds,
		proxies:  deps.Proxies,
		domains:  deps.Domains,
		chain:    deps.Chain,
		resolver: deps.Resolver,
		hostKey:  deps.HostKey,
		asset:    deps.Asset,
		system:   map[uint64]*systemCacheEntry{},
		procs:    map[uint64]*procCacheEntry{},
		nets:     map[uint64]*netCacheEntry{},
		history:  map[uint64]*nodeHistory{},
	}
	n := normalize(cfg)
	m.cfg.Store(&n)
	return m
}

// conf returns the current live config snapshot.
func (m *Manager) conf() Config { return *m.cfg.Load() }

// ApplyConfig hot-swaps the insights tuning. Wired from the settings center so
// enabling/disabling the dashboard and retuning the sampling budget take effect
// without a restart.
func (m *Manager) ApplyConfig(cfg Config) {
	n := normalize(cfg)
	m.cfg.Store(&n)
}

func (m *Manager) Enabled() bool { return m.conf().Enabled }

// gateAndLoad performs the asset-grant check and loads the node + credential
// from the repos. Shared by all three insights methods.
func (m *Manager) gateAndLoad(ctx context.Context, userID, nodeID uint64) (*nodeAndCred, error) {
	if !m.conf().Enabled {
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

type nodeAndCred struct {
	node *model.Node
	cred *model.Credential
}

// System returns the cached SystemSnapshot for the node, or runs a fresh
// SSH poll if the cache is stale.
func (m *Manager) System(ctx context.Context, userID, nodeID uint64) (*SystemSnapshot, error) {
	loaded, err := m.gateAndLoad(ctx, userID, nodeID)
	if err != nil {
		return nil, err
	}
	if cached := m.cachedSystem(nodeID); cached != nil {
		return cached, nil
	}
	v, err, _ := m.flight.Do(systemKey(nodeID), func() (any, error) {
		return m.collectSystem(ctx, nodeID, loaded)
	})
	if err != nil {
		return nil, err
	}
	snap := v.(*SystemSnapshot)
	return snap, nil
}

func (m *Manager) cachedSystem(nodeID uint64) *SystemSnapshot {
	m.mu.Lock()
	defer m.mu.Unlock()
	if e, ok := m.system[nodeID]; ok && time.Since(e.at) < m.conf().CacheTTL {
		copy := e.snap
		return &copy
	}
	return nil
}

func (m *Manager) collectSystem(ctx context.Context, nodeID uint64, l *nodeAndCred) (*SystemSnapshot, error) {
	cctx, cancel := context.WithTimeout(ctx, m.conf().SSHTimeout)
	defer cancel()
	out, err := sshExec(cctx, m.chain, m.resolver, m.hostKey, m.conf().SSHTimeout, m.proxies, m.domains, l.node, l.cred, systemScript)
	if err != nil {
		return nil, err
	}
	m.mu.Lock()
	hist := m.history[nodeID]
	if hist == nil {
		hist = &nodeHistory{}
		m.history[nodeID] = hist
	}
	prev := hist.prev
	m.mu.Unlock()

	now := time.Now().UTC()
	snap, cur := parseSystemBundle(out, prev, now)

	m.mu.Lock()
	hist.prev = cur
	m.system[nodeID] = &systemCacheEntry{at: now, snap: snap}
	m.mu.Unlock()
	return &snap, nil
}

// Processes returns processes sorted by `sortBy` (cpu / mem / rss / pid).
func (m *Manager) Processes(ctx context.Context, userID, nodeID uint64, sortBy string, limit int) (*ProcessList, error) {
	loaded, err := m.gateAndLoad(ctx, userID, nodeID)
	if err != nil {
		return nil, err
	}
	if cached := m.cachedProcs(nodeID, sortBy); cached != nil {
		return m.trim(cached, limit), nil
	}
	v, err, _ := m.flight.Do(procKey(nodeID), func() (any, error) {
		return m.collectProcs(ctx, nodeID, loaded, sortBy)
	})
	if err != nil {
		return nil, err
	}
	list := v.(*ProcessList)
	return m.trim(list, limit), nil
}

func (m *Manager) cachedProcs(nodeID uint64, sortBy string) *ProcessList {
	m.mu.Lock()
	defer m.mu.Unlock()
	if e, ok := m.procs[nodeID]; ok && time.Since(e.at) < m.conf().CacheTTL && e.sortBy == sortBy {
		copy := e.list
		return &copy
	}
	return nil
}

func (m *Manager) collectProcs(ctx context.Context, nodeID uint64, l *nodeAndCred, sortBy string) (*ProcessList, error) {
	cctx, cancel := context.WithTimeout(ctx, m.conf().SSHTimeout)
	defer cancel()
	out, err := sshExec(cctx, m.chain, m.resolver, m.hostKey, m.conf().SSHTimeout, m.proxies, m.domains, l.node, l.cred, processesScript)
	if err != nil {
		return nil, err
	}
	list := parseProcessesBundle(out, sortBy)
	m.mu.Lock()
	m.procs[nodeID] = &procCacheEntry{at: time.Now(), sortBy: sortBy, list: list}
	m.mu.Unlock()
	return &list, nil
}

func (m *Manager) trim(list *ProcessList, limit int) *ProcessList {
	if limit <= 0 || limit > m.conf().ProcessLimit {
		limit = m.conf().ProcessLimit
	}
	cp := *list
	if len(cp.Processes) > limit {
		cp.Processes = cp.Processes[:limit]
	}
	return &cp
}

// Network returns the listening-sockets snapshot for the node.
func (m *Manager) Network(ctx context.Context, userID, nodeID uint64) (*NetworkSnapshot, error) {
	loaded, err := m.gateAndLoad(ctx, userID, nodeID)
	if err != nil {
		return nil, err
	}
	if cached := m.cachedNet(nodeID); cached != nil {
		return cached, nil
	}
	v, err, _ := m.flight.Do(netKey(nodeID), func() (any, error) {
		return m.collectNet(ctx, nodeID, loaded)
	})
	if err != nil {
		return nil, err
	}
	snap := v.(*NetworkSnapshot)
	return snap, nil
}

func (m *Manager) cachedNet(nodeID uint64) *NetworkSnapshot {
	m.mu.Lock()
	defer m.mu.Unlock()
	if e, ok := m.nets[nodeID]; ok && time.Since(e.at) < m.conf().CacheTTL {
		copy := e.snap
		return &copy
	}
	return nil
}

func (m *Manager) collectNet(ctx context.Context, nodeID uint64, l *nodeAndCred) (*NetworkSnapshot, error) {
	cctx, cancel := context.WithTimeout(ctx, m.conf().SSHTimeout)
	defer cancel()
	out, err := sshExec(cctx, m.chain, m.resolver, m.hostKey, m.conf().SSHTimeout, m.proxies, m.domains, l.node, l.cred, networkScript)
	if err != nil {
		return nil, err
	}
	snap := parseNetworkBundle(out)
	m.mu.Lock()
	m.nets[nodeID] = &netCacheEntry{at: time.Now(), snap: snap}
	m.mu.Unlock()
	return &snap, nil
}

func systemKey(nodeID uint64) string { return fmt.Sprintf("sys-%d", nodeID) }
func procKey(nodeID uint64) string   { return fmt.Sprintf("ps-%d", nodeID) }
func netKey(nodeID uint64) string    { return fmt.Sprintf("net-%d", nodeID) }
