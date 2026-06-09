package ssh

import (
	"context"
	"fmt"
	"net"
	"time"

	xssh "golang.org/x/crypto/ssh"
	"golang.org/x/net/proxy"
)

// DialConfig is everything Connect needs to build an ssh.Client over an
// arbitrary ContextDialer.
type DialConfig struct {
	Addr           string
	User           string
	Auth           []xssh.AuthMethod
	HostKey        xssh.HostKeyCallback
	Timeout        time.Duration
	ClientVersion  string
	BannerCallback xssh.BannerCallback
}

// Connect dials addr via the provided ContextDialer and performs the SSH
// handshake. The returned *ssh.Client owns the underlying net.Conn.
func Connect(ctx context.Context, d proxy.ContextDialer, cfg DialConfig) (*xssh.Client, error) {
	if cfg.Timeout <= 0 {
		cfg.Timeout = 15 * time.Second
	}
	if cfg.HostKey == nil {
		cfg.HostKey = xssh.InsecureIgnoreHostKey()
	}
	dialCtx, cancel := context.WithTimeout(ctx, cfg.Timeout)
	defer cancel()
	conn, err := d.DialContext(dialCtx, "tcp", cfg.Addr)
	if err != nil {
		return nil, fmt.Errorf("dial %s: %w", cfg.Addr, err)
	}
	// Apply deadline to the handshake itself, then clear after success.
	if dl, ok := dialCtx.Deadline(); ok {
		_ = conn.SetDeadline(dl)
	}
	sshCfg := &xssh.ClientConfig{
		User:            cfg.User,
		Auth:            cfg.Auth,
		HostKeyCallback: cfg.HostKey,
		Timeout:         cfg.Timeout,
		ClientVersion:   cfg.ClientVersion,
		BannerCallback:  cfg.BannerCallback,
	}
	sc, chans, reqs, err := xssh.NewClientConn(conn, cfg.Addr, sshCfg)
	if err != nil {
		_ = conn.Close()
		return nil, fmt.Errorf("ssh handshake: %w", err)
	}
	_ = conn.SetDeadline(time.Time{})
	return xssh.NewClient(sc, chans, reqs), nil
}

// KeepAlive runs ssh keepalive probes until ctx is done or the client returns
// an error. It is safe to launch as a goroutine and never blocks the caller.
func KeepAlive(ctx context.Context, c *xssh.Client, interval time.Duration) {
	if interval <= 0 {
		return
	}
	t := time.NewTicker(interval)
	defer t.Stop()
	for {
		select {
		case <-ctx.Done():
			return
		case <-t.C:
			_, _, err := c.SendRequest("keepalive@openssh.com", true, nil)
			if err != nil {
				return
			}
		}
	}
}

// ProbeRTT measures the gateway↔target round-trip time by sending one
// keepalive@openssh.com global request and timing the reply. The server doesn't
// recognise that request so it answers with FAILURE (ok=false, err=nil) — the
// round trip itself is what we time, exactly as OpenSSH's ServerAlive probe
// does. A non-nil error means the connection is dead. The send runs in a
// goroutine so ctx can bound a stalled link; the buffered channel prevents a
// goroutine leak if ctx fires first.
func ProbeRTT(ctx context.Context, c *xssh.Client) (time.Duration, error) {
	start := time.Now()
	done := make(chan error, 1)
	go func() {
		_, _, err := c.SendRequest("keepalive@openssh.com", true, nil)
		done <- err
	}()
	select {
	case err := <-done:
		if err != nil {
			return 0, err
		}
		return time.Since(start), nil
	case <-ctx.Done():
		return 0, ctx.Err()
	}
}

// AddrOf assembles a host:port string.
func AddrOf(host string, port int) string {
	if port == 0 {
		port = 22
	}
	return net.JoinHostPort(host, fmt.Sprintf("%d", port))
}
