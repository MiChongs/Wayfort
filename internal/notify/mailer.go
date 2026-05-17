// Package notify wraps an SMTP client with an async send queue so callers
// (login flows, MFA, anomaly detection) never block on network I/O.
package notify

import (
	"context"
	"errors"
	"fmt"
	"sync/atomic"
	"time"

	"github.com/wneessen/go-mail"
	"go.uber.org/zap"
)

type Config struct {
	Host       string
	Port       int
	Username   string
	Password   string
	From       string
	UseTLS     string // "none" | "starttls" | "tls"
	ChanSize   int
	MaxRetries int
}

type Mailer struct {
	cfg     Config
	logger  *zap.Logger
	client  *mail.Client
	queue   chan Message
	dropped atomic.Uint64
	done    chan struct{}
}

type Message struct {
	To      []string
	Subject string
	HTML    string
	Text    string
}

func New(cfg Config, logger *zap.Logger) (*Mailer, error) {
	if cfg.Host == "" {
		return nil, errors.New("smtp host required")
	}
	if cfg.Port == 0 {
		cfg.Port = 587
	}
	if cfg.ChanSize <= 0 {
		cfg.ChanSize = 256
	}
	if cfg.MaxRetries <= 0 {
		cfg.MaxRetries = 3
	}
	opts := []mail.Option{
		mail.WithPort(cfg.Port),
		mail.WithUsername(cfg.Username),
		mail.WithPassword(cfg.Password),
	}
	switch cfg.UseTLS {
	case "tls":
		opts = append(opts, mail.WithSSL())
	case "starttls":
		opts = append(opts, mail.WithTLSPortPolicy(mail.TLSMandatory))
	default:
		opts = append(opts, mail.WithTLSPortPolicy(mail.TLSOpportunistic))
	}
	if cfg.Username != "" {
		opts = append(opts, mail.WithSMTPAuth(mail.SMTPAuthPlain))
	}
	c, err := mail.NewClient(cfg.Host, opts...)
	if err != nil {
		return nil, fmt.Errorf("smtp client: %w", err)
	}
	return &Mailer{
		cfg:    cfg,
		logger: logger,
		client: c,
		queue:  make(chan Message, cfg.ChanSize),
		done:   make(chan struct{}),
	}, nil
}

// Send enqueues a message. Never blocks; over capacity drops + counts.
func (m *Mailer) Send(msg Message) {
	if m == nil {
		return
	}
	select {
	case m.queue <- msg:
	default:
		m.dropped.Add(1)
	}
}

// Run drives the background worker until ctx is canceled.
func (m *Mailer) Run(ctx context.Context) error {
	for {
		select {
		case <-ctx.Done():
			close(m.done)
			return ctx.Err()
		case msg := <-m.queue:
			m.attempt(msg)
		}
	}
}

func (m *Mailer) Wait() { <-m.done }

func (m *Mailer) attempt(msg Message) {
	for i := 0; i < m.cfg.MaxRetries; i++ {
		if err := m.deliver(msg); err == nil {
			return
		} else {
			m.logger.Warn("smtp send failed, retrying",
				zap.Int("attempt", i+1), zap.Error(err))
		}
		time.Sleep(time.Duration(1<<i) * time.Second)
	}
	m.logger.Error("smtp send permanently failed", zap.Strings("to", msg.To))
}

func (m *Mailer) deliver(msg Message) error {
	em := mail.NewMsg()
	if err := em.From(m.cfg.From); err != nil {
		return err
	}
	if err := em.To(msg.To...); err != nil {
		return err
	}
	em.Subject(msg.Subject)
	if msg.HTML != "" {
		em.SetBodyString(mail.TypeTextHTML, msg.HTML)
	}
	if msg.Text != "" {
		em.AddAlternativeString(mail.TypeTextPlain, msg.Text)
	}
	if msg.HTML == "" && msg.Text != "" {
		em.SetBodyString(mail.TypeTextPlain, msg.Text)
	}
	return m.client.DialAndSend(em)
}
