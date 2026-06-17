package docker

import (
	"context"
	"errors"
	"fmt"
	"strings"
	"sync"
	"time"

	"github.com/michongs/wayfort/internal/asset"
	"github.com/michongs/wayfort/internal/audit"
	"github.com/michongs/wayfort/internal/model"
	"github.com/michongs/wayfort/internal/repo"
	"github.com/michongs/wayfort/internal/sshrun"
	"go.uber.org/zap"
	"golang.org/x/sync/singleflight"
)

type Config struct {
	Enabled    bool
	CacheTTL   time.Duration // default 5s
	SSHTimeout time.Duration // default 15s — `docker ps` can be slow on busy hosts
	LogLimit   int           // default 500 lines
}

var (
	ErrDisabled     = errors.New("docker: disabled by config")
	ErrUnauthorized = errors.New("docker: not authorised on node")
	ErrUnavailable  = errors.New("docker: daemon unreachable on node")
	ErrInvalidID    = errors.New("docker: invalid container id (shell metachars rejected)")
	ErrInvalidRef   = errors.New("docker: invalid image reference")
	ErrInvalidArg   = errors.New("docker: invalid argument")
)

type Manager struct {
	cfg    Config
	logger *zap.Logger
	nodes  *repo.NodeRepo
	creds  *repo.CredentialRepo
	asset  *asset.Resolver
	audit  *audit.Writer
	deps   sshrun.Deps

	mu     sync.Mutex
	cache  map[uint64]*cacheEntry
	flight singleflight.Group
}

type cacheEntry struct {
	at         time.Time
	status     Status
	containers []Container
	images     []Image
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
		cfg.CacheTTL = 5 * time.Second
	}
	if cfg.SSHTimeout <= 0 {
		cfg.SSHTimeout = 15 * time.Second
	}
	if cfg.LogLimit <= 0 {
		cfg.LogLimit = 500
	}
	return &Manager{
		cfg:    cfg,
		logger: deps.Logger,
		nodes:  deps.Nodes,
		creds:  deps.Creds,
		asset:  deps.Asset,
		audit:  deps.Audit,
		deps:   deps.SSH,
		cache:  map[uint64]*cacheEntry{},
	}
}

func (m *Manager) Enabled() bool { return m.cfg.Enabled }

// Status returns daemon-level availability + summary counts.
func (m *Manager) Status(ctx context.Context, userID, nodeID uint64) (*Status, error) {
	c, err := m.snapshot(ctx, userID, nodeID)
	if err != nil {
		return nil, err
	}
	return &c.status, nil
}

func (m *Manager) ListContainers(ctx context.Context, userID, nodeID uint64) ([]Container, error) {
	c, err := m.snapshot(ctx, userID, nodeID)
	if err != nil {
		return nil, err
	}
	if !c.status.Available {
		return nil, ErrUnavailable
	}
	return c.containers, nil
}

func (m *Manager) ListImages(ctx context.Context, userID, nodeID uint64) ([]Image, error) {
	c, err := m.snapshot(ctx, userID, nodeID)
	if err != nil {
		return nil, err
	}
	if !c.status.Available {
		return nil, ErrUnavailable
	}
	return c.images, nil
}

func (m *Manager) snapshot(ctx context.Context, userID, nodeID uint64) (*cacheEntry, error) {
	loaded, err := m.gateAndLoad(ctx, userID, nodeID)
	if err != nil {
		return nil, err
	}
	if c := m.cached(nodeID); c != nil {
		return c, nil
	}
	v, err, _ := m.flight.Do(fmt.Sprintf("snap:%d", nodeID), func() (any, error) {
		return m.collect(ctx, nodeID, loaded)
	})
	if err != nil {
		return nil, err
	}
	return v.(*cacheEntry), nil
}

func (m *Manager) collect(ctx context.Context, nodeID uint64, l *nodeAndCred) (*cacheEntry, error) {
	cctx, cancel := context.WithTimeout(ctx, m.cfg.SSHTimeout)
	defer cancel()
	now := time.Now().UTC()
	entry := &cacheEntry{at: now}
	// 1. version probe — also tells us if daemon is reachable.
	verRes, _ := sshrun.Run(cctx, m.deps, l.node, l.cred,
		"docker version --format '{{json .}}' 2>/dev/null", m.cfg.SSHTimeout)
	entry.status = parseVersion(verRes.Stdout)
	entry.status.SampledAt = now
	if !entry.status.Available {
		m.store(nodeID, entry)
		return entry, nil
	}
	// 2. containers + images in parallel-ish (sequential SSH; cheap once
	// daemon is up).
	cRes, err := sshrun.Run(cctx, m.deps, l.node, l.cred,
		"docker ps -a --no-trunc --format '{{json .}}' 2>/dev/null", m.cfg.SSHTimeout)
	if err != nil && cRes.Stdout == "" {
		return nil, fmt.Errorf("docker ps: %w (stderr: %s)", err, truncate(cRes.Stderr, 200))
	}
	containers, err := parseContainers(cRes.Stdout)
	if err != nil {
		return nil, fmt.Errorf("parse containers: %w", err)
	}
	iRes, err := sshrun.Run(cctx, m.deps, l.node, l.cred,
		"docker images --format '{{json .}}' 2>/dev/null", m.cfg.SSHTimeout)
	if err != nil && iRes.Stdout == "" {
		return nil, fmt.Errorf("docker images: %w (stderr: %s)", err, truncate(iRes.Stderr, 200))
	}
	images, err := parseImages(iRes.Stdout)
	if err != nil {
		return nil, fmt.Errorf("parse images: %w", err)
	}
	for i := range containers {
		containers[i].SampledAt = now
	}
	for i := range images {
		images[i].SampledAt = now
	}
	entry.containers = containers
	entry.images = images
	entry.status.Containers = len(containers)
	entry.status.Images = len(images)
	m.store(nodeID, entry)
	return entry, nil
}

func (m *Manager) cached(nodeID uint64) *cacheEntry {
	m.mu.Lock()
	defer m.mu.Unlock()
	if c, ok := m.cache[nodeID]; ok && time.Since(c.at) < m.cfg.CacheTTL {
		return c
	}
	return nil
}

func (m *Manager) store(nodeID uint64, c *cacheEntry) {
	m.mu.Lock()
	defer m.mu.Unlock()
	m.cache[nodeID] = c
}

func (m *Manager) invalidate(nodeID uint64) {
	m.mu.Lock()
	defer m.mu.Unlock()
	delete(m.cache, nodeID)
}

// Logs streams the tail of `docker logs <cid>`. Tail is clamped to LogLimit.
func (m *Manager) Logs(ctx context.Context, userID, nodeID uint64, containerID string, tail int) (*LogsResponse, error) {
	loaded, err := m.gateAndLoad(ctx, userID, nodeID)
	if err != nil {
		return nil, err
	}
	if !safeContainerID(containerID) {
		return nil, ErrInvalidID
	}
	if tail <= 0 || tail > m.cfg.LogLimit {
		tail = m.cfg.LogLimit
	}
	cctx, cancel := context.WithTimeout(ctx, m.cfg.SSHTimeout)
	defer cancel()
	cmd := fmt.Sprintf("docker logs --tail %d --timestamps %s 2>&1", tail, containerID)
	res, err := sshrun.Run(cctx, m.deps, loaded.node, loaded.cred, cmd, m.cfg.SSHTimeout)
	if err != nil && res.Stdout == "" {
		return nil, fmt.Errorf("docker logs: %w (stderr: %s)", err, truncate(res.Stderr, 200))
	}
	return &LogsResponse{ContainerID: containerID, Tail: tail, Logs: res.Stdout}, nil
}

// Do executes the requested container action with audit logging. Cache is
// invalidated on success so the next list call picks up the new state.
func (m *Manager) Do(ctx context.Context, userID, nodeID uint64, claims AuditClaims, action Action, containerID string, force bool) error {
	loaded, err := m.gateAndLoad(ctx, userID, nodeID)
	if err != nil {
		return err
	}
	if !safeContainerID(containerID) {
		return ErrInvalidID
	}
	var cmd string
	switch action {
	case ActionStart:
		cmd = "docker start " + containerID
	case ActionStop:
		cmd = "docker stop " + containerID
	case ActionRestart:
		cmd = "docker restart " + containerID
	case ActionPause:
		cmd = "docker pause " + containerID
	case ActionUnpause:
		cmd = "docker unpause " + containerID
	case ActionKill:
		cmd = "docker kill " + containerID
	case ActionRemove:
		if force {
			cmd = "docker rm -f " + containerID
		} else {
			cmd = "docker rm " + containerID
		}
	default:
		return fmt.Errorf("unknown action %q", action)
	}
	cctx, cancel := context.WithTimeout(ctx, m.cfg.SSHTimeout)
	defer cancel()
	res, err := sshrun.Run(cctx, m.deps, loaded.node, loaded.cred, cmd, m.cfg.SSHTimeout)
	if err != nil {
		return fmt.Errorf("docker %s: %w (stderr: %s)", action, err, truncate(res.Stderr, 200))
	}
	m.invalidate(nodeID)
	m.recordAudit(claims, nodeID, model.AuditDockerAction, fmt.Sprintf("%s %s", action, containerID))
	return nil
}

// Inspect returns the curated + raw `docker inspect` of one container.
func (m *Manager) Inspect(ctx context.Context, userID, nodeID uint64, containerID string) (*ContainerDetail, error) {
	loaded, err := m.gateAndLoad(ctx, userID, nodeID)
	if err != nil {
		return nil, err
	}
	if !safeContainerID(containerID) {
		return nil, ErrInvalidID
	}
	cctx, cancel := context.WithTimeout(ctx, m.cfg.SSHTimeout)
	defer cancel()
	res, err := sshrun.Run(cctx, m.deps, loaded.node, loaded.cred, "docker inspect "+containerID+" 2>&1", m.cfg.SSHTimeout)
	if err != nil && res.Stdout == "" {
		return nil, fmt.Errorf("docker inspect: %w (stderr: %s)", err, truncate(res.Stderr, 200))
	}
	d, err := parseInspect(res.Stdout)
	if err != nil {
		return nil, err
	}
	d.SampledAt = time.Now().UTC()
	return d, nil
}

// Stats returns a one-shot `docker stats` for all containers.
func (m *Manager) Stats(ctx context.Context, userID, nodeID uint64) ([]ContainerStats, error) {
	loaded, err := m.gateAndLoad(ctx, userID, nodeID)
	if err != nil {
		return nil, err
	}
	cctx, cancel := context.WithTimeout(ctx, m.cfg.SSHTimeout)
	defer cancel()
	res, err := sshrun.Run(cctx, m.deps, loaded.node, loaded.cred,
		"docker stats --no-stream --format '{{json .}}' 2>/dev/null", m.cfg.SSHTimeout)
	if err != nil && res.Stdout == "" {
		return nil, fmt.Errorf("docker stats: %w", err)
	}
	return parseStats(res.Stdout), nil
}

// Top returns `docker top <cid>`.
func (m *Manager) Top(ctx context.Context, userID, nodeID uint64, containerID string) (*TopResult, error) {
	loaded, err := m.gateAndLoad(ctx, userID, nodeID)
	if err != nil {
		return nil, err
	}
	if !safeContainerID(containerID) {
		return nil, ErrInvalidID
	}
	cctx, cancel := context.WithTimeout(ctx, m.cfg.SSHTimeout)
	defer cancel()
	res, err := sshrun.Run(cctx, m.deps, loaded.node, loaded.cred, "docker top "+containerID+" 2>&1", m.cfg.SSHTimeout)
	if err != nil && res.Stdout == "" {
		return nil, fmt.Errorf("docker top: %w (stderr: %s)", err, truncate(res.Stderr, 200))
	}
	t := parseTop(containerID, res.Stdout)
	return &t, nil
}

// Networks / Volumes list the daemon's networks and volumes.
func (m *Manager) Networks(ctx context.Context, userID, nodeID uint64) ([]Network, error) {
	loaded, err := m.gateAndLoad(ctx, userID, nodeID)
	if err != nil {
		return nil, err
	}
	cctx, cancel := context.WithTimeout(ctx, m.cfg.SSHTimeout)
	defer cancel()
	res, _ := sshrun.Run(cctx, m.deps, loaded.node, loaded.cred,
		"docker network ls --format '{{json .}}' 2>/dev/null", m.cfg.SSHTimeout)
	return parseNetworks(res.Stdout), nil
}

func (m *Manager) Volumes(ctx context.Context, userID, nodeID uint64) ([]Volume, error) {
	loaded, err := m.gateAndLoad(ctx, userID, nodeID)
	if err != nil {
		return nil, err
	}
	cctx, cancel := context.WithTimeout(ctx, m.cfg.SSHTimeout)
	defer cancel()
	res, _ := sshrun.Run(cctx, m.deps, loaded.node, loaded.cred,
		"docker volume ls --format '{{json .}}' 2>/dev/null", m.cfg.SSHTimeout)
	return parseVolumes(res.Stdout), nil
}

// Rename renames a container (docker:manage).
func (m *Manager) Rename(ctx context.Context, userID, nodeID uint64, claims AuditClaims, containerID, newName string) error {
	loaded, err := m.gateAndLoad(ctx, userID, nodeID)
	if err != nil {
		return err
	}
	if !safeContainerID(containerID) || !safeContainerID(newName) {
		return ErrInvalidID
	}
	cctx, cancel := context.WithTimeout(ctx, m.cfg.SSHTimeout)
	defer cancel()
	res, err := sshrun.Run(cctx, m.deps, loaded.node, loaded.cred,
		fmt.Sprintf("docker rename %s %s 2>&1", containerID, newName), m.cfg.SSHTimeout)
	if err != nil {
		return fmt.Errorf("docker rename: %w (stderr: %s)", err, truncate(res.Stderr+res.Stdout, 200))
	}
	m.invalidate(nodeID)
	m.recordAudit(claims, nodeID, model.AuditDockerAction, fmt.Sprintf("rename %s → %s", containerID, newName))
	return nil
}

// PullImage pulls an image reference (docker:manage). Output is captured (slow).
func (m *Manager) PullImage(ctx context.Context, userID, nodeID uint64, claims AuditClaims, ref string) (*ActionResult, error) {
	loaded, err := m.gateAndLoad(ctx, userID, nodeID)
	if err != nil {
		return nil, err
	}
	if !safeImageRef(ref) {
		return nil, ErrInvalidRef
	}
	cctx, cancel := context.WithTimeout(ctx, 180*time.Second)
	defer cancel()
	res, err := sshrun.Run(cctx, m.deps, loaded.node, loaded.cred,
		fmt.Sprintf("docker pull %s 2>&1", shellQuote(ref)), 180*time.Second)
	out := res.Stdout
	if out == "" {
		out = res.Stderr
	}
	if err != nil && out == "" {
		return nil, fmt.Errorf("docker pull: %w", err)
	}
	m.invalidate(nodeID)
	m.recordAudit(claims, nodeID, model.AuditDockerAction, "pull "+ref)
	return &ActionResult{OK: err == nil, Output: strings.TrimRight(out, "\n")}, nil
}

// RemoveImage removes an image (docker:manage).
func (m *Manager) RemoveImage(ctx context.Context, userID, nodeID uint64, claims AuditClaims, ref string, force bool) (*ActionResult, error) {
	loaded, err := m.gateAndLoad(ctx, userID, nodeID)
	if err != nil {
		return nil, err
	}
	if !safeImageRef(ref) {
		return nil, ErrInvalidRef
	}
	flag := ""
	if force {
		flag = "-f "
	}
	cctx, cancel := context.WithTimeout(ctx, m.cfg.SSHTimeout)
	defer cancel()
	res, err := sshrun.Run(cctx, m.deps, loaded.node, loaded.cred,
		fmt.Sprintf("docker rmi %s%s 2>&1", flag, shellQuote(ref)), m.cfg.SSHTimeout)
	out := res.Stdout
	if out == "" {
		out = res.Stderr
	}
	if err != nil && out == "" {
		return nil, fmt.Errorf("docker rmi: %w", err)
	}
	m.invalidate(nodeID)
	m.recordAudit(claims, nodeID, model.AuditDockerAction, "rmi "+ref)
	return &ActionResult{OK: err == nil, Output: strings.TrimRight(out, "\n")}, nil
}

// Prune reclaims space (docker:manage). `what` ∈ system/image/container/volume/builder/network.
func (m *Manager) Prune(ctx context.Context, userID, nodeID uint64, claims AuditClaims, what string) (*ActionResult, error) {
	loaded, err := m.gateAndLoad(ctx, userID, nodeID)
	if err != nil {
		return nil, err
	}
	if !safePruneWhat(what) {
		return nil, ErrInvalidArg
	}
	var cmd string
	switch what {
	case "system":
		cmd = "docker system prune -af 2>&1"
	case "image":
		cmd = "docker image prune -af 2>&1" // -a: also remove unused (not just dangling)
	default:
		cmd = fmt.Sprintf("docker %s prune -f 2>&1", what)
	}
	cctx, cancel := context.WithTimeout(ctx, 120*time.Second)
	defer cancel()
	res, err := sshrun.Run(cctx, m.deps, loaded.node, loaded.cred, cmd, 120*time.Second)
	out := res.Stdout
	if out == "" {
		out = res.Stderr
	}
	if err != nil && out == "" {
		return nil, fmt.Errorf("docker prune: %w", err)
	}
	m.invalidate(nodeID)
	m.recordAudit(claims, nodeID, model.AuditDockerAction, "prune "+what)
	return &ActionResult{OK: err == nil, Output: strings.TrimRight(out, "\n")}, nil
}

// ---- helpers ----

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

// AuditClaims keeps the docker package independent of internal/auth.
type AuditClaims struct {
	UserID   uint64
	Username string
	ClientIP string
}

func (m *Manager) recordAudit(c AuditClaims, nodeID uint64, kind model.AuditEventKind, payload string) {
	if m.audit == nil {
		return
	}
	nid := nodeID
	m.audit.Log(model.AuditLog{
		Kind:     kind,
		UserID:   c.UserID,
		Username: c.Username,
		NodeID:   &nid,
		ClientIP: c.ClientIP,
		Payload:  payload,
	})
}
