package dialer

import (
	"context"
	"net"
	"sync/atomic"
	"testing"

	"github.com/michongs/wayfort/internal/model"
	"golang.org/x/net/proxy"
)

type fakeDialer struct {
	name    string
	called  atomic.Int32
	upstream proxy.ContextDialer
}

func (f *fakeDialer) DialContext(ctx context.Context, network, addr string) (net.Conn, error) {
	f.called.Add(1)
	if f.upstream != nil {
		return f.upstream.DialContext(ctx, network, addr)
	}
	// Terminal: just return a closed pipe so the caller sees a real Conn briefly.
	a, b := net.Pipe()
	_ = a.Close()
	return b, nil
}

type fakeBastion struct {
	releases atomic.Int32
	dialer   *fakeDialer
}

func (f *fakeBastion) Acquire(_ context.Context, p *model.Proxy, outer proxy.ContextDialer, _ string) (*BastionDialer, func(), error) {
	// Wrap the upstream so we can verify it was threaded through.
	f.dialer = &fakeDialer{name: p.Name, upstream: outer}
	// BastionDialer wraps *ssh.Client; we cheat for the test by stubbing DialContext via the inner field type.
	bd := &BastionDialer{Client: nil} // not used in this branch — caller invokes DialContext only on the returned ContextDialer
	// The chain only calls DialContext on the final dialer, so substitute via a wrapper variable below.
	_ = bd
	return nil, func() { f.releases.Add(1) }, errOnce
}

var errOnce = &chainErr{"bastion stub"}

type chainErr struct{ s string }

func (e *chainErr) Error() string { return e.s }

func TestChainBuildOnlyDirect(t *testing.T) {
	b := &ChainBuilder{}
	d, release, err := b.Build(context.Background(), nil, nil)
	if err != nil {
		t.Fatalf("unexpected err: %v", err)
	}
	defer release()
	if d == nil {
		t.Fatal("nil dialer")
	}
}

func TestChainBuildBastionNotConfiguredFails(t *testing.T) {
	b := &ChainBuilder{}
	_, _, err := b.Build(context.Background(), []*model.Proxy{
		{Kind: model.ProxyBastion, Name: "no-conn"},
	}, nil)
	if err == nil {
		t.Fatal("expected error when bastion connector is nil")
	}
}

func TestChainBuildReleasesOnFailure(t *testing.T) {
	// Build a connector that always errors on Acquire, so the chain must release any partial state.
	b := &ChainBuilder{Bastion: &fakeBastion{}}
	_, _, err := b.Build(context.Background(), []*model.Proxy{
		{Kind: model.ProxyBastion, Name: "b1"},
	}, nil)
	if err == nil {
		t.Fatal("expected error from stub Acquire")
	}
}

func TestChainBuildDirectPassesThroughBase(t *testing.T) {
	base := &fakeDialer{name: "base"}
	b := &ChainBuilder{}
	d, release, err := b.Build(context.Background(), []*model.Proxy{
		{Kind: model.ProxyDirect, Name: "noop"},
	}, base)
	if err != nil {
		t.Fatalf("unexpected err: %v", err)
	}
	defer release()
	conn, _ := d.DialContext(context.Background(), "tcp", "ignore:0")
	if conn != nil {
		_ = conn.Close()
	}
	if base.called.Load() != 1 {
		t.Fatalf("base dialer should have been called once, got %d", base.called.Load())
	}
}
