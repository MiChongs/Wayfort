// Package socks5 is a minimal CONNECT-only SOCKS5 server used to let a
// subprocess (guacd, the freerdp-worker, …) reach targets that sit behind our
// existing ContextDialer chain (SOCKS5 + SSH bastion). A per-session Listener is
// bound to 127.0.0.1; the subprocess is told to dial through it, and every
// CONNECT we receive is translated into the supplied dialer's DialContext call —
// i.e. it traverses the full bastion/proxy hop chain.
//
// Extracted from internal/protocols/guacamole so the desktop (FreeRDP) backend
// can reuse the exact same proxy-chain forwarding guacd already uses, without
// either side depending on the other.
package socks5

import (
	"context"
	"encoding/binary"
	"errors"
	"fmt"
	"io"
	"net"
	"strconv"
	"sync/atomic"
	"time"

	"go.uber.org/zap"
	"golang.org/x/net/proxy"
)

// Listener owns a TCP listener bound to 127.0.0.1:0 and converts each incoming
// SOCKS5 CONNECT into a tunnelled connection using the supplied ContextDialer.
//
// The listener is single-use: it is meant to back exactly one subprocess
// session and accepts an unbounded number of TCP connects but always tunnels
// them through the same dialer. Close stops the acceptor goroutine.
type Listener struct {
	ln       net.Listener
	target   string
	dialer   proxy.ContextDialer
	logger   *zap.Logger
	wg       atomic.Int32
	closing  atomic.Bool
	username string
	password string
}

// New starts a listener and returns it ready to accept. It MUST be closed when
// the session ends to free the bound port and stop the accept goroutine.
//
// ctx scopes the bind and the per-connection dial deadlines, so pass a
// session-lived context (e.g. context.Background() guarded by Close) rather than
// a short request context — otherwise dials fail once the request returns.
func New(ctx context.Context, listenHost string, dialer proxy.ContextDialer, target string, logger *zap.Logger) (*Listener, error) {
	if listenHost == "" {
		listenHost = "127.0.0.1"
	}
	if logger == nil {
		logger = zap.NewNop()
	}
	lc := &net.ListenConfig{}
	ln, err := lc.Listen(ctx, "tcp", net.JoinHostPort(listenHost, "0"))
	if err != nil {
		return nil, err
	}
	l := &Listener{ln: ln, target: target, dialer: dialer, logger: logger}
	go l.accept(ctx)
	return l, nil
}

// WithAuth requires the SOCKS5 client to authenticate with the given creds.
// Useful as a sanity check so only the colocated subprocess talks to us.
func (l *Listener) WithAuth(user, pass string) *Listener {
	l.username = user
	l.password = pass
	return l
}

// Addr returns the chosen 127.0.0.1:<port>.
func (l *Listener) Addr() *net.TCPAddr { return l.ln.Addr().(*net.TCPAddr) }

// Host returns the bind host.
func (l *Listener) Host() string { return l.Addr().IP.String() }

// Port returns the bind port chosen by the kernel.
func (l *Listener) Port() int { return l.Addr().Port }

// Close stops accepting and shuts down the listener.
func (l *Listener) Close() error {
	if !l.closing.CompareAndSwap(false, true) {
		return nil
	}
	return l.ln.Close()
}

func (l *Listener) accept(ctx context.Context) {
	for {
		conn, err := l.ln.Accept()
		if err != nil {
			if l.closing.Load() {
				return
			}
			if errors.Is(err, net.ErrClosed) {
				return
			}
			l.logger.Warn("socks accept failed", zap.Error(err))
			return
		}
		go l.handle(ctx, conn)
	}
}

func (l *Listener) handle(ctx context.Context, c net.Conn) {
	defer c.Close()
	if err := c.SetDeadline(time.Now().Add(15 * time.Second)); err != nil {
		return
	}
	if err := l.handshake(c); err != nil {
		l.logger.Debug("socks handshake failed", zap.Error(err))
		return
	}
	target, err := l.readRequest(c)
	if err != nil {
		l.logger.Debug("socks request parse failed", zap.Error(err))
		return
	}
	_ = c.SetDeadline(time.Time{})

	// We honour the *destination* the client asked for. In practice the
	// subprocess dials the target we configured in the connect instruction, but
	// treating this as a generic SOCKS5 (rather than hard-wiring the target)
	// keeps the listener composable with other clients.
	dialCtx, cancel := context.WithTimeout(ctx, 15*time.Second)
	defer cancel()
	dst, err := l.dialer.DialContext(dialCtx, "tcp", target)
	if err != nil {
		writeReply(c, 0x04) // host unreachable
		return
	}
	defer dst.Close()
	if err := writeReply(c, 0x00); err != nil {
		return
	}

	// Bi-directional copy. errgroup is overkill; two goroutines + a done chan.
	done := make(chan struct{}, 2)
	go func() { _, _ = io.Copy(dst, c); done <- struct{}{} }()
	go func() { _, _ = io.Copy(c, dst); done <- struct{}{} }()
	<-done
}

func (l *Listener) handshake(c net.Conn) error {
	buf := make([]byte, 257)
	if _, err := io.ReadFull(c, buf[:2]); err != nil {
		return err
	}
	if buf[0] != 0x05 {
		return fmt.Errorf("bad socks version %d", buf[0])
	}
	n := int(buf[1])
	if n == 0 {
		return fmt.Errorf("no auth methods offered")
	}
	if _, err := io.ReadFull(c, buf[:n]); err != nil {
		return err
	}
	noAuth := false
	userPass := false
	for _, m := range buf[:n] {
		switch m {
		case 0x00:
			noAuth = true
		case 0x02:
			userPass = true
		}
	}
	switch {
	case l.username != "" && userPass:
		if _, err := c.Write([]byte{0x05, 0x02}); err != nil {
			return err
		}
		return l.authUserPass(c)
	case l.username == "" && noAuth:
		_, err := c.Write([]byte{0x05, 0x00})
		return err
	default:
		_, _ = c.Write([]byte{0x05, 0xff})
		return fmt.Errorf("no acceptable auth method")
	}
}

func (l *Listener) authUserPass(c net.Conn) error {
	buf := make([]byte, 513)
	if _, err := io.ReadFull(c, buf[:2]); err != nil {
		return err
	}
	if buf[0] != 0x01 {
		return fmt.Errorf("bad user/pass version %d", buf[0])
	}
	ulen := int(buf[1])
	if _, err := io.ReadFull(c, buf[:ulen+1]); err != nil {
		return err
	}
	user := string(buf[:ulen])
	plen := int(buf[ulen])
	if _, err := io.ReadFull(c, buf[:plen]); err != nil {
		return err
	}
	pass := string(buf[:plen])
	if user != l.username || pass != l.password {
		_, _ = c.Write([]byte{0x01, 0x01})
		return fmt.Errorf("bad credentials")
	}
	_, err := c.Write([]byte{0x01, 0x00})
	return err
}

func (l *Listener) readRequest(c net.Conn) (string, error) {
	hdr := make([]byte, 4)
	if _, err := io.ReadFull(c, hdr); err != nil {
		return "", err
	}
	if hdr[0] != 0x05 || hdr[1] != 0x01 {
		return "", fmt.Errorf("only CONNECT supported (cmd=%d)", hdr[1])
	}
	var host string
	switch hdr[3] {
	case 0x01: // IPv4
		b := make([]byte, 4)
		if _, err := io.ReadFull(c, b); err != nil {
			return "", err
		}
		host = net.IP(b).String()
	case 0x03: // domain
		l := make([]byte, 1)
		if _, err := io.ReadFull(c, l); err != nil {
			return "", err
		}
		b := make([]byte, l[0])
		if _, err := io.ReadFull(c, b); err != nil {
			return "", err
		}
		host = string(b)
	case 0x04: // IPv6
		b := make([]byte, 16)
		if _, err := io.ReadFull(c, b); err != nil {
			return "", err
		}
		host = "[" + net.IP(b).String() + "]"
	default:
		return "", fmt.Errorf("unsupported addr type %d", hdr[3])
	}
	pb := make([]byte, 2)
	if _, err := io.ReadFull(c, pb); err != nil {
		return "", err
	}
	port := binary.BigEndian.Uint16(pb)
	return net.JoinHostPort(host, strconv.Itoa(int(port))), nil
}

func writeReply(c net.Conn, status byte) error {
	_, err := c.Write([]byte{0x05, status, 0x00, 0x01, 0, 0, 0, 0, 0, 0})
	return err
}
