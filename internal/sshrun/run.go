// Package sshrun is a thin wrapper around dialer + ssh.Connect + session.Run
// that lets ops-style modules (firewall, docker, …) execute a one-shot
// command on a managed node without each rebuilding the SSH plumbing.
//
// Existing callers (insights, sftp, ai/bridge) still carry their own
// equivalents; this package is the entry point for new code only. Migrating
// them is a separate cleanup PR.
package sshrun

import (
	"bufio"
	"bytes"
	"context"
	"errors"
	"fmt"
	"strings"
	"time"

	"github.com/michongs/wayfort/internal/dialer"
	"github.com/michongs/wayfort/internal/domain"
	"github.com/michongs/wayfort/internal/model"
	"github.com/michongs/wayfort/internal/repo"
	pkgssh "github.com/michongs/wayfort/internal/ssh"
	xssh "golang.org/x/crypto/ssh"
)

// Deps groups the shared SSH plumbing dependencies that ops modules need.
type Deps struct {
	Chain    *dialer.ChainBuilder
	Resolver *pkgssh.Resolver
	HostKey  xssh.HostKeyCallback
	Proxies  *repo.ProxyRepo
	// Domains resolves a node's connectivity from its network domain. Nil-safe:
	// when unset, dialing falls back to the legacy node.ProxyChain so behaviour
	// is unchanged until wired (security-architecture.md §3).
	Domains *domain.Resolver
}

// HopsFor resolves the proxy hops to reach node, preferring the network-domain
// resolver when wired and falling back to the legacy per-node ProxyChain.
// Exported so callers that already hold a Deps (logs, ops modules) route through
// the same domain-aware seam instead of calling ResolveHops on node.ProxyChain.
func (d Deps) HopsFor(ctx context.Context, node *model.Node) ([]*model.Proxy, error) {
	if d.Domains != nil {
		plan, err := d.Domains.Resolve(ctx, node)
		if err != nil {
			return nil, err
		}
		return plan.Hops, nil
	}
	return ResolveHops(ctx, d.Proxies, node.ProxyChain)
}

// Result holds the captured stdout/stderr and exit status (non-zero exits
// surface as ExitError on the returned error).
type Result struct {
	Stdout string
	Stderr string
}

// Run dials the node (respecting its proxy chain), executes command, and
// returns the captured output. The ctx deadline + dialTimeout combine: each
// SSH dial gets at most dialTimeout, and the overall session can't outlive
// the ctx. dialTimeout <= 0 falls back to 10s.
func Run(
	ctx context.Context,
	d Deps,
	node *model.Node,
	cred *model.Credential,
	command string,
	dialTimeout time.Duration,
) (Result, error) {
	if node == nil {
		return Result{}, errors.New("sshrun: node is nil")
	}
	if cred == nil {
		return Result{}, errors.New("sshrun: credential is nil")
	}
	hops, err := d.HopsFor(ctx, node)
	if err != nil {
		return Result{}, fmt.Errorf("resolve hops: %w", err)
	}
	finalDialer, release, err := d.Chain.Build(ctx, hops, nil)
	if err != nil {
		return Result{}, fmt.Errorf("build chain: %w", err)
	}
	defer release()
	methods, err := d.Resolver.AuthMethods(cred)
	if err != nil {
		return Result{}, fmt.Errorf("decode cred: %w", err)
	}
	if dialTimeout <= 0 {
		dialTimeout = 10 * time.Second
	}
	client, err := pkgssh.Connect(ctx, finalDialer, pkgssh.DialConfig{
		Addr:    pkgssh.AddrOf(node.Host, node.Port),
		User:    pkgssh.PreferredUser(cred, node.Username),
		Auth:    methods,
		HostKey: d.HostKey,
		Timeout: dialTimeout,
	})
	if err != nil {
		return Result{}, err
	}
	defer client.Close()
	sess, err := client.NewSession()
	if err != nil {
		return Result{}, fmt.Errorf("new session: %w", err)
	}
	defer sess.Close()
	var stdout, stderr bytes.Buffer
	sess.Stdout = &stdout
	sess.Stderr = &stderr
	done := make(chan error, 1)
	go func() { done <- sess.Run(command) }()
	select {
	case err = <-done:
	case <-ctx.Done():
		_ = sess.Signal(xssh.SIGINT)
		_ = sess.Close()
		return Result{Stdout: stdout.String(), Stderr: stderr.String()}, ctx.Err()
	}
	res := Result{Stdout: stdout.String(), Stderr: stderr.String()}
	if err != nil {
		// Mirror insights' behaviour: a non-zero exit with non-empty stdout
		// is still useful (`docker ps` and `ufw status` exit 0 anyway, but
		// `iptables -L` may return non-zero on permission errors with
		// useful stderr). The caller decides.
		return res, err
	}
	return res, nil
}

// RunStream dials the node and runs command, invoking onLine for each stdout
// line as it arrives (instead of buffering the whole output like Run). It is the
// real-time path for long-running ops commands — streamed package installs,
// config applies — so the UI sees progress immediately. Merge stderr into the
// command (append `2>&1`) if you need it; RunStream only reads stdout. The
// remote process is signalled + the session closed when ctx is cancelled (the
// SSE handler cancels on client disconnect). dialTimeout <= 0 falls back to 10s.
func RunStream(
	ctx context.Context,
	d Deps,
	node *model.Node,
	cred *model.Credential,
	command string,
	dialTimeout time.Duration,
	onLine func(string),
) error {
	if node == nil {
		return errors.New("sshrun: node is nil")
	}
	if cred == nil {
		return errors.New("sshrun: credential is nil")
	}
	hops, err := d.HopsFor(ctx, node)
	if err != nil {
		return fmt.Errorf("resolve hops: %w", err)
	}
	finalDialer, release, err := d.Chain.Build(ctx, hops, nil)
	if err != nil {
		return fmt.Errorf("build chain: %w", err)
	}
	defer release()
	methods, err := d.Resolver.AuthMethods(cred)
	if err != nil {
		return fmt.Errorf("decode cred: %w", err)
	}
	if dialTimeout <= 0 {
		dialTimeout = 10 * time.Second
	}
	client, err := pkgssh.Connect(ctx, finalDialer, pkgssh.DialConfig{
		Addr:    pkgssh.AddrOf(node.Host, node.Port),
		User:    pkgssh.PreferredUser(cred, node.Username),
		Auth:    methods,
		HostKey: d.HostKey,
		Timeout: dialTimeout,
	})
	if err != nil {
		return err
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
	if err := sess.Start(command); err != nil {
		return fmt.Errorf("start: %w", err)
	}
	// Kill the remote command when the caller's ctx ends.
	go func() {
		<-ctx.Done()
		_ = sess.Signal(xssh.SIGINT)
		_ = sess.Close()
		_ = client.Close()
	}()
	scanner := bufio.NewScanner(stdout)
	scanner.Buffer(make([]byte, 0, 64*1024), 1024*1024)
	for scanner.Scan() {
		if ctx.Err() != nil {
			break
		}
		onLine(scanner.Text())
	}
	_ = sess.Wait()
	return ctx.Err()
}

// ResolveHops parses a node's comma-separated proxy chain ("3,1") into
// concrete model.Proxy rows. Exported so callers in other packages can
// share the parsing.
func ResolveHops(ctx context.Context, proxies *repo.ProxyRepo, chain string) ([]*model.Proxy, error) {
	if chain == "" {
		return nil, nil
	}
	out := make([]*model.Proxy, 0, 4)
	for _, raw := range splitChain(chain) {
		var id uint64
		_, err := fmt.Sscanf(raw, "%d", &id)
		if err != nil {
			return nil, fmt.Errorf("invalid proxy id %q", raw)
		}
		p, err := proxies.FindByID(ctx, id)
		if err != nil {
			return nil, err
		}
		if p == nil {
			return nil, fmt.Errorf("proxy %d not found", id)
		}
		out = append(out, p)
	}
	return out, nil
}

func splitChain(s string) []string {
	parts := strings.Split(s, ",")
	out := make([]string, 0, len(parts))
	for _, p := range parts {
		t := strings.TrimSpace(p)
		if t != "" {
			out = append(out, t)
		}
	}
	return out
}
