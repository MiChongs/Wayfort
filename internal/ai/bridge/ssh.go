// Package bridge wires the AI tool layer to the rest of the gateway: SSH
// command execution, SFTP file ops, and TCP port-forward management. None of
// these have ever been exposed at the package level before — they were locked
// inside WebSocket session handlers — so the bridge is the canonical reusable
// entrypoint.
package bridge

import (
	"bytes"
	"context"
	"fmt"
	"io"
	"os"
	"time"

	"github.com/michongs/jumpserver-anonymous/internal/ai/tools"
	"github.com/michongs/jumpserver-anonymous/internal/asset"
	"github.com/michongs/jumpserver-anonymous/internal/dialer"
	"github.com/michongs/jumpserver-anonymous/internal/model"
	"github.com/michongs/jumpserver-anonymous/internal/repo"
	pkgssh "github.com/michongs/jumpserver-anonymous/internal/ssh"
	"github.com/michongs/jumpserver-anonymous/internal/sftp"
	xssh "golang.org/x/crypto/ssh"
)

// NodeRunner runs arbitrary commands on a node, going through the same
// ChainBuilder + asset-grant verification as a normal WebSSH session.
type NodeRunner struct {
	Nodes    *repo.NodeRepo
	Creds    *repo.CredentialRepo
	Proxies  *repo.ProxyRepo
	Resolver *pkgssh.Resolver
	Chain    *dialer.ChainBuilder
	HostKey  xssh.HostKeyCallback
	Asset    *asset.Resolver
	DialTimeout time.Duration
}

// Exec implements tools.NodeRunner. It honours the caller's asset:connect
// authorisation and times out after timeoutSec.
func (r *NodeRunner) Exec(ctx context.Context, userID uint64, nodeID uint64, command string, timeoutSec int) (string, string, int, error) {
	if r.Asset != nil {
		ok, err := r.Asset.Check(ctx, userID, nodeID, asset.ActionConnect)
		if err != nil {
			return "", "", -1, err
		}
		if !ok {
			return "", "", -1, fmt.Errorf("user %d not authorised on node %d", userID, nodeID)
		}
	}
	node, err := r.Nodes.FindByID(ctx, nodeID)
	if err != nil || node == nil {
		return "", "", -1, fmt.Errorf("node %d not found", nodeID)
	}
	hops, err := resolveHops(ctx, r.Proxies, node.ProxyChain)
	if err != nil {
		return "", "", -1, err
	}
	finalDialer, release, err := r.Chain.Build(ctx, hops, nil)
	if err != nil {
		return "", "", -1, err
	}
	defer release()
	cred, err := r.Creds.FindByID(ctx, node.CredentialID)
	if err != nil || cred == nil {
		return "", "", -1, fmt.Errorf("credential lookup failed")
	}
	methods, err := r.Resolver.AuthMethods(cred)
	if err != nil {
		return "", "", -1, err
	}
	dialTimeout := r.DialTimeout
	if dialTimeout <= 0 {
		dialTimeout = 15 * time.Second
	}
	client, err := pkgssh.Connect(ctx, finalDialer, pkgssh.DialConfig{
		Addr: pkgssh.AddrOf(node.Host, node.Port),
		User: pkgssh.PreferredUser(cred, node.Username),
		Auth: methods, HostKey: r.HostKey, Timeout: dialTimeout,
	})
	if err != nil {
		return "", "", -1, err
	}
	defer client.Close()
	sess, err := client.NewSession()
	if err != nil {
		return "", "", -1, err
	}
	defer sess.Close()

	var stdout, stderr bytes.Buffer
	sess.Stdout = &stdout
	sess.Stderr = &stderr

	cmdCtx, cancel := context.WithTimeout(ctx, time.Duration(timeoutSec)*time.Second)
	defer cancel()
	done := make(chan error, 1)
	go func() { done <- sess.Run(command) }()
	select {
	case err = <-done:
	case <-cmdCtx.Done():
		_ = sess.Signal(xssh.SIGINT)
		_ = sess.Close()
		return stdout.String(), stderr.String(), 124, fmt.Errorf("command timed out after %ds", timeoutSec)
	}
	exit := 0
	if err != nil {
		if exitErr, ok := err.(*xssh.ExitError); ok {
			exit = exitErr.ExitStatus()
		} else {
			return stdout.String(), stderr.String(), -1, err
		}
	}
	return stdout.String(), stderr.String(), exit, nil
}

// SFTPRunner implements tools.SFTPRunner.
type SFTPRunner struct {
	Conn  *sftp.Connector
	Asset *asset.Resolver
}

func (r *SFTPRunner) checkAuth(ctx context.Context, userID, nodeID uint64) error {
	if r.Asset == nil {
		return nil
	}
	ok, err := r.Asset.Check(ctx, userID, nodeID, asset.ActionConnect)
	if err != nil {
		return err
	}
	if !ok {
		return fmt.Errorf("user %d not authorised on node %d", userID, nodeID)
	}
	return nil
}

func (r *SFTPRunner) ListDir(ctx context.Context, userID, nodeID uint64, path string) ([]tools.SFTPEntry, error) {
	if err := r.checkAuth(ctx, userID, nodeID); err != nil {
		return nil, err
	}
	client, closer, err := r.Conn.Open(ctx, nodeID)
	if err != nil {
		return nil, err
	}
	defer closer()
	if path == "" {
		path = "."
	}
	entries, err := client.ReadDir(path)
	if err != nil {
		return nil, err
	}
	out := make([]tools.SFTPEntry, 0, len(entries))
	for _, e := range entries {
		out = append(out, tools.SFTPEntry{
			Name: e.Name(), Path: joinPath(path, e.Name()),
			IsDir: e.IsDir(), Size: e.Size(),
			Mode: e.Mode().String(), ModTime: e.ModTime().UTC().Format(time.RFC3339),
		})
	}
	return out, nil
}

func (r *SFTPRunner) ReadFile(ctx context.Context, userID, nodeID uint64, path string, maxBytes int64) ([]byte, error) {
	if err := r.checkAuth(ctx, userID, nodeID); err != nil {
		return nil, err
	}
	client, closer, err := r.Conn.Open(ctx, nodeID)
	if err != nil {
		return nil, err
	}
	defer closer()
	f, err := client.Open(path)
	if err != nil {
		return nil, err
	}
	defer f.Close()
	if maxBytes <= 0 {
		maxBytes = 256 * 1024
	}
	return io.ReadAll(io.LimitReader(f, maxBytes))
}

func (r *SFTPRunner) WriteFile(ctx context.Context, userID, nodeID uint64, path string, content []byte, mode uint32) error {
	if err := r.checkAuth(ctx, userID, nodeID); err != nil {
		return err
	}
	client, closer, err := r.Conn.Open(ctx, nodeID)
	if err != nil {
		return err
	}
	defer closer()
	f, err := client.Create(path)
	if err != nil {
		return err
	}
	defer f.Close()
	if _, err := f.Write(content); err != nil {
		return err
	}
	if mode == 0 {
		mode = 0o644
	}
	_ = client.Chmod(path, os.FileMode(mode))
	return nil
}

func (r *SFTPRunner) DeletePath(ctx context.Context, userID, nodeID uint64, path string) error {
	if err := r.checkAuth(ctx, userID, nodeID); err != nil {
		return err
	}
	client, closer, err := r.Conn.Open(ctx, nodeID)
	if err != nil {
		return err
	}
	defer closer()
	info, statErr := client.Stat(path)
	if statErr == nil && info.IsDir() {
		return client.RemoveDirectory(path)
	}
	return client.Remove(path)
}

// ----- helpers -----

func resolveHops(ctx context.Context, proxies *repo.ProxyRepo, chain string) ([]*model.Proxy, error) {
	if chain == "" {
		return nil, nil
	}
	out := make([]*model.Proxy, 0, 4)
	for _, raw := range splitNonEmpty(chain, ',') {
		var id uint64
		_, err := fmt.Sscanf(raw, "%d", &id)
		if err != nil {
			return nil, fmt.Errorf("invalid proxy id %q", raw)
		}
		p, err := proxies.FindByID(ctx, id)
		if err != nil || p == nil {
			return nil, fmt.Errorf("proxy %s not found", raw)
		}
		out = append(out, p)
	}
	return out, nil
}

func splitNonEmpty(s string, sep rune) []string {
	var out []string
	start := 0
	for i, r := range s {
		if r == sep {
			if i > start {
				out = append(out, s[start:i])
			}
			start = i + 1
		}
	}
	if start < len(s) {
		out = append(out, s[start:])
	}
	return out
}

func joinPath(a, b string) string {
	if a == "" || a == "." {
		return b
	}
	if a[len(a)-1] == '/' {
		return a + b
	}
	return a + "/" + b
}

