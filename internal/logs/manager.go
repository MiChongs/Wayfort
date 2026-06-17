package logs

import (
	"bufio"
	"context"
	"fmt"
	"strings"
	"time"

	"github.com/michongs/wayfort/internal/asset"
	"github.com/michongs/wayfort/internal/model"
	"github.com/michongs/wayfort/internal/repo"
	pkgssh "github.com/michongs/wayfort/internal/ssh"
	"github.com/michongs/wayfort/internal/sshrun"
	"go.uber.org/zap"
	xssh "golang.org/x/crypto/ssh"
)

type Config struct {
	Enabled    bool
	SSHTimeout time.Duration // default 10s (one-shot ops)
	FollowMax  time.Duration // hard cap on a single follow stream; default 30m
}

type Manager struct {
	cfg    Config
	logger *zap.Logger
	nodes  *repo.NodeRepo
	creds  *repo.CredentialRepo
	asset  *asset.Resolver
	deps   sshrun.Deps
	hostKey xssh.HostKeyCallback
}

type Deps struct {
	Logger  *zap.Logger
	Nodes   *repo.NodeRepo
	Creds   *repo.CredentialRepo
	Asset   *asset.Resolver
	SSH     sshrun.Deps
	HostKey xssh.HostKeyCallback
}

func NewManager(cfg Config, deps Deps) *Manager {
	if cfg.SSHTimeout <= 0 {
		cfg.SSHTimeout = 10 * time.Second
	}
	if cfg.FollowMax <= 0 {
		cfg.FollowMax = 30 * time.Minute
	}
	m := &Manager{
		cfg: cfg, logger: deps.Logger, nodes: deps.Nodes, creds: deps.Creds,
		asset: deps.Asset, deps: deps.SSH, hostKey: deps.HostKey,
	}
	if m.logger != nil {
		m.logger.Info("logs subsystem ready", zap.Bool("enabled", cfg.Enabled))
	}
	return m
}

func (m *Manager) Enabled() bool { return m.cfg.Enabled }

// List enumerates journald availability + readable log files.
func (m *Manager) List(ctx context.Context, userID, nodeID uint64) (*LogList, error) {
	loaded, err := m.gateAndLoad(ctx, userID, nodeID)
	if err != nil {
		return nil, err
	}
	cctx, cancel := context.WithTimeout(ctx, m.cfg.SSHTimeout)
	defer cancel()
	res, err := sshrun.Run(cctx, m.deps, loaded.node, loaded.cred, fileListScript, m.cfg.SSHTimeout)
	if err != nil && res.Stdout == "" {
		return nil, classifySSHError(err, "list logs")
	}
	hasJournal, files := parseFileList(res.Stdout)
	return &LogList{HasJournal: hasJournal, Files: files, SampledAt: time.Now().UTC()}, nil
}

// buildCmd assembles the (validated) tail/follow command. follow toggles -f/-F.
func buildCmd(source, ref string, lines int, follow bool) (string, error) {
	if lines <= 0 || lines > 5000 {
		lines = 200
	}
	switch source {
	case "journal":
		if !validUnit(ref) {
			return "", ErrBadRef
		}
		f := ""
		if follow {
			f = " -f"
		}
		return fmt.Sprintf("journalctl -u %s -n %d%s --no-hostname 2>&1", shellQuote(ref), lines, f), nil
	case "file":
		if !validPath(ref) {
			return "", ErrBadRef
		}
		flag := "-n"
		if follow {
			flag = "-F -n"
		}
		return fmt.Sprintf("tail %s %d %s 2>&1", flag, lines, shellQuote(ref)), nil
	default:
		return "", ErrBadSource
	}
}

// Tail returns a one-shot tail of a unit or file.
func (m *Manager) Tail(ctx context.Context, userID, nodeID uint64, source, ref string, lines int) (*LogTail, error) {
	loaded, err := m.gateAndLoad(ctx, userID, nodeID)
	if err != nil {
		return nil, err
	}
	cmd, err := buildCmd(source, ref, lines, false)
	if err != nil {
		return nil, err
	}
	cctx, cancel := context.WithTimeout(ctx, m.cfg.SSHTimeout)
	defer cancel()
	res, err := sshrun.Run(cctx, m.deps, loaded.node, loaded.cred, cmd, m.cfg.SSHTimeout)
	if err != nil && res.Stdout == "" {
		return nil, classifySSHError(err, "tail")
	}
	return &LogTail{
		Source: source, Ref: ref, Lines: lines,
		Text: strings.TrimRight(res.Stdout, "\n"), SampledAt: time.Now().UTC(),
	}, nil
}

// Follow streams a unit/file's log lines to onLine until ctx is cancelled (the
// SSE handler cancels when the client disconnects) or FollowMax elapses. The
// remote `journalctl -f` / `tail -F` process is killed on cancel.
func (m *Manager) Follow(ctx context.Context, userID, nodeID uint64, source, ref string, lines int, onLine func(string)) error {
	loaded, err := m.gateAndLoad(ctx, userID, nodeID)
	if err != nil {
		return err
	}
	cmd, err := buildCmd(source, ref, lines, true)
	if err != nil {
		return err
	}
	fctx, cancel := context.WithTimeout(ctx, m.cfg.FollowMax)
	defer cancel()

	hops, err := m.deps.HopsFor(fctx, loaded.node)
	if err != nil {
		return fmt.Errorf("resolve hops: %w", err)
	}
	dialer, release, err := m.deps.Chain.Build(fctx, hops, nil)
	if err != nil {
		return fmt.Errorf("build chain: %w", err)
	}
	defer release()
	methods, err := m.deps.Resolver.AuthMethods(loaded.cred)
	if err != nil {
		return fmt.Errorf("decode cred: %w", err)
	}
	client, err := pkgssh.Connect(fctx, dialer, pkgssh.DialConfig{
		Addr:    pkgssh.AddrOf(loaded.node.Host, loaded.node.Port),
		User:    pkgssh.PreferredUser(loaded.cred, loaded.node.Username),
		Auth:    methods,
		HostKey: m.hostKey,
		Timeout: m.cfg.SSHTimeout,
	})
	if err != nil {
		return classifySSHError(err, "follow connect")
	}
	defer client.Close()
	sess, err := client.NewSession()
	if err != nil {
		return fmt.Errorf("new session: %w", err)
	}
	defer sess.Close()
	stdout, err := sess.StdoutPipe()
	if err != nil {
		return fmt.Errorf("stdout pipe: %w", err)
	}
	sess.Stderr = nil
	if err := sess.Start(cmd); err != nil {
		return fmt.Errorf("start: %w", err)
	}
	// Kill the remote follower when the caller's ctx ends.
	go func() {
		<-fctx.Done()
		_ = sess.Signal(xssh.SIGINT)
		_ = sess.Close()
		_ = client.Close()
	}()
	scanner := bufio.NewScanner(stdout)
	scanner.Buffer(make([]byte, 0, 64*1024), 1024*1024)
	for scanner.Scan() {
		if fctx.Err() != nil {
			break
		}
		onLine(scanner.Text())
	}
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

func classifySSHError(err error, op string) error {
	if err == nil {
		return nil
	}
	e := strings.ToLower(err.Error())
	switch {
	case strings.Contains(e, "unable to authenticate") || strings.Contains(e, "no route to host") ||
		strings.Contains(e, "i/o timeout") || strings.Contains(e, "connection refused"):
		return fmt.Errorf("%w: %v (%s)", ErrUnreachable, err, op)
	default:
		return fmt.Errorf("%s: %w", op, err)
	}
}
