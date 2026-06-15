package sshpool

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"fmt"
	"sync"
	"time"

	"github.com/michongs/jumpserver-anonymous/internal/config"
	"github.com/michongs/jumpserver-anonymous/internal/dialer"
	"github.com/michongs/jumpserver-anonymous/internal/model"
	pkgssh "github.com/michongs/jumpserver-anonymous/internal/ssh"
	xssh "golang.org/x/crypto/ssh"
	"golang.org/x/net/proxy"
)

// CredentialProvider is the minimal abstraction the pool needs to authenticate
// against a bastion. Implementations live in internal/api or wherever owns the
// credential repo.
type CredentialProvider interface {
	ForProxy(ctx context.Context, p *model.Proxy) (user string, methods []xssh.AuthMethod, fingerprint []byte, err error)
}

type Pool struct {
	cfg      config.SSHPoolConfig
	creds    CredentialProvider
	hostKeys xssh.HostKeyCallback

	mu      sync.Mutex
	entries map[string]*entry

	stop chan struct{}
}

func New(cfg config.SSHPoolConfig, creds CredentialProvider, hostKey xssh.HostKeyCallback) *Pool {
	if cfg.MaxSessionsPerClient <= 0 {
		cfg.MaxSessionsPerClient = 8
	}
	return &Pool{
		cfg:      cfg,
		creds:    creds,
		hostKeys: hostKey,
		entries:  make(map[string]*entry),
		stop:     make(chan struct{}),
	}
}

// Acquire returns a BastionDialer rooted at the requested proxy. The returned
// release MUST be called once the dialer is no longer used; it decrements the
// refcount and lets the janitor reclaim idle clients.
func (p *Pool) Acquire(ctx context.Context, hop *model.Proxy, outer proxy.ContextDialer, outerKey string) (*dialer.BastionDialer, func(), error) {
	user, methods, fp, err := p.creds.ForProxy(ctx, hop)
	if err != nil {
		return nil, nil, err
	}
	addr := pkgssh.AddrOf(hop.Host, hop.Port)
	// Fold outerKey (the upstream-chain identity) into the pool key so a client
	// established over one front chain is never reused for a request resolved to
	// a different one, even with identical bastion endpoint + credentials.
	key := poolKey(addr, user, fp, outerKey)

	p.mu.Lock()
	e, ok := p.entries[key]
	if !ok {
		e = &entry{key: key, maxSessions: int32(p.cfg.MaxSessionsPerClient)}
		p.entries[key] = e
	}
	p.mu.Unlock()

	slot, err := p.pickOrSpawn(ctx, e, addr, user, methods, outer)
	if err != nil {
		return nil, nil, err
	}
	slot.refs.Add(1)
	slot.lastUsed.Store(time.Now().UnixNano())
	bd := &dialer.BastionDialer{Client: slot.client}
	release := func() {
		slot.refs.Add(-1)
		slot.lastUsed.Store(time.Now().UnixNano())
	}
	return bd, release, nil
}

func (p *Pool) pickOrSpawn(ctx context.Context, e *entry, addr, user string, methods []xssh.AuthMethod, outer proxy.ContextDialer) (*clientSlot, error) {
	e.mu.Lock()
	defer e.mu.Unlock()
	e.pruneDead()
	if s := e.pickAvailable(); s != nil {
		return s, nil
	}
	if e.disposed {
		return nil, fmt.Errorf("pool entry disposed")
	}
	// All current slots are full or none exist; spin a new client.
	client, err := pkgssh.Connect(ctx, outer, pkgssh.DialConfig{
		Addr:    addr,
		User:    user,
		Auth:    methods,
		HostKey: p.hostKeys,
		Timeout: p.cfg.DialTimeout,
	})
	if err != nil {
		return nil, err
	}
	slot := newSlot(client)
	e.clients = append(e.clients, slot)
	go p.watch(e, slot)
	if p.cfg.Keepalive > 0 {
		go pkgssh.KeepAlive(context.Background(), client, p.cfg.Keepalive)
	}
	return slot, nil
}

// Run drives a janitor that evicts idle dead slots. It blocks until ctx is
// canceled, so call it inside an errgroup.
func (p *Pool) Run(ctx context.Context) error {
	t := time.NewTicker(p.cfg.IdleEviction / 2)
	defer t.Stop()
	for {
		select {
		case <-ctx.Done():
			p.shutdown()
			return ctx.Err()
		case <-p.stop:
			p.shutdown()
			return nil
		case <-t.C:
			p.sweep()
		}
	}
}

func (p *Pool) Stop() { close(p.stop) }

func (p *Pool) watch(e *entry, slot *clientSlot) {
	_ = slot.client.Wait()
	slot.dead.Store(true)
	e.mu.Lock()
	e.pruneDead()
	e.mu.Unlock()
}

func (p *Pool) sweep() {
	cutoff := time.Now().Add(-p.cfg.IdleEviction).UnixNano()
	p.mu.Lock()
	for key, e := range p.entries {
		e.mu.Lock()
		live := e.clients[:0]
		for _, s := range e.clients {
			if s.dead.Load() {
				continue
			}
			if s.refs.Load() == 0 && s.lastUsed.Load() < cutoff {
				_ = s.client.Close()
				s.dead.Store(true)
				continue
			}
			live = append(live, s)
		}
		e.clients = live
		empty := len(e.clients) == 0
		e.mu.Unlock()
		if empty {
			delete(p.entries, key)
		}
	}
	p.mu.Unlock()
}

func (p *Pool) shutdown() {
	p.mu.Lock()
	defer p.mu.Unlock()
	for key, e := range p.entries {
		e.mu.Lock()
		for _, s := range e.clients {
			_ = s.client.Close()
			s.dead.Store(true)
		}
		e.disposed = true
		e.mu.Unlock()
		delete(p.entries, key)
	}
}

func poolKey(addr, user string, fingerprint []byte, outerKey string) string {
	h := sha256.New()
	h.Write([]byte(addr))
	h.Write([]byte{'|'})
	h.Write([]byte(user))
	h.Write([]byte{'|'})
	h.Write(fingerprint)
	h.Write([]byte{'|'})
	h.Write([]byte(outerKey))
	return hex.EncodeToString(h.Sum(nil))
}
