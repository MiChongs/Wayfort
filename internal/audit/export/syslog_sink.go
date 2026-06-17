package export

import (
	"context"
	"crypto/tls"
	"fmt"
	"net"
	"sync"
	"time"

	"github.com/michongs/wayfort/internal/model"
)

// SyslogSink ships events as newline-delimited CEF over a TCP (optionally TLS)
// connection to a SIEM collector. It lazily (re)dials on demand so a collector
// restart doesn't permanently break delivery. One goroutine drives Send, so the
// connection needs no locking beyond the reconnect guard.
type SyslogSink struct {
	addr      string
	useTLS    bool
	tlsConfig *tls.Config

	mu   sync.Mutex
	conn net.Conn
}

// NewSyslogSink builds a CEF/syslog sink. addr is host:port; tlsConfig non-nil
// dials TLS (use &tls.Config{} for system roots, or set InsecureSkipVerify for
// a lab collector).
func NewSyslogSink(addr string, tlsConfig *tls.Config) *SyslogSink {
	return &SyslogSink{addr: addr, useTLS: tlsConfig != nil, tlsConfig: tlsConfig}
}

func (s *SyslogSink) Name() string { return "syslog-cef" }

func (s *SyslogSink) Send(ctx context.Context, ev model.AuditLog) error {
	line := FormatCEF(ev) + "\n"
	conn, err := s.dial(ctx)
	if err != nil {
		return err
	}
	if dl, ok := ctx.Deadline(); ok {
		_ = conn.SetWriteDeadline(dl)
	} else {
		_ = conn.SetWriteDeadline(time.Now().Add(10 * time.Second))
	}
	if _, err := conn.Write([]byte(line)); err != nil {
		s.reset(conn)
		return fmt.Errorf("syslog write: %w", err)
	}
	return nil
}

func (s *SyslogSink) dial(ctx context.Context) (net.Conn, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.conn != nil {
		return s.conn, nil
	}
	d := net.Dialer{Timeout: 10 * time.Second}
	var conn net.Conn
	var err error
	if s.useTLS {
		conn, err = tls.DialWithDialer(&d, "tcp", s.addr, s.tlsConfig)
	} else {
		conn, err = d.DialContext(ctx, "tcp", s.addr)
	}
	if err != nil {
		return nil, fmt.Errorf("syslog dial %s: %w", s.addr, err)
	}
	s.conn = conn
	return conn, nil
}

// reset drops a broken connection so the next Send redials.
func (s *SyslogSink) reset(broken net.Conn) {
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.conn == broken {
		_ = s.conn.Close()
		s.conn = nil
	}
}
