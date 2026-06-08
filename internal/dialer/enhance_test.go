package dialer

import (
	"context"
	"net"
	"testing"
	"time"

	"github.com/michongs/jumpserver-anonymous/internal/model"
	"golang.org/x/net/proxy"
)

// stubHealth lets tests drive failover ordering deterministically.
type stubHealth struct {
	up      map[uint64]bool
	latency map[uint64]int64
}

func (s stubHealth) IsUp(id uint64) bool      { return s.up[id] }
func (s stubHealth) LatencyMS(id uint64) int64 { return s.latency[id] }

func memberSeq(ms []builtMember) []uint64 {
	out := make([]uint64, len(ms))
	for i, m := range ms {
		out[i] = m.proxyID
	}
	return out
}

func TestFailoverOrderedByPriority(t *testing.T) {
	f := &failoverDialer{
		strategy: model.FailoverOrdered,
		members: []builtMember{
			{proxyID: 1, priority: 2},
			{proxyID: 2, priority: 0},
			{proxyID: 3, priority: 1},
		},
	}
	got := memberSeq(f.order())
	want := []uint64{2, 3, 1}
	for i := range want {
		if got[i] != want[i] {
			t.Fatalf("ordered: got %v want %v", got, want)
		}
	}
}

func TestFailoverRoundRobinRotates(t *testing.T) {
	mk := func() *failoverDialer {
		return &failoverDialer{
			strategy: model.FailoverRoundRobin,
			members:  []builtMember{{proxyID: 1}, {proxyID: 2}, {proxyID: 3}},
		}
	}
	f := mk()
	first := memberSeq(f.order())[0]
	second := memberSeq(f.order())[0]
	if first == second {
		t.Fatalf("round_robin did not rotate: first=%d second=%d", first, second)
	}
}

func TestFailoverHealthWeightedPrefersUpThenLatency(t *testing.T) {
	f := &failoverDialer{
		strategy: model.FailoverHealthWeighted,
		health: stubHealth{
			up:      map[uint64]bool{1: false, 2: true, 3: true},
			latency: map[uint64]int64{2: 120, 3: 40},
		},
		members: []builtMember{{proxyID: 1}, {proxyID: 2}, {proxyID: 3}},
	}
	got := memberSeq(f.order())
	// up members first, lowest latency first → 3 (40ms), 2 (120ms), then down 1.
	if got[0] != 3 || got[1] != 2 || got[2] != 1 {
		t.Fatalf("health_weighted: got %v want [3 2 1]", got)
	}
}

func TestValidateChainShapeNewKinds(t *testing.T) {
	// socks4 without endpoint → error.
	issues := ValidateChainShape([]*model.Proxy{{ID: 1, Kind: model.ProxySOCKS4, Name: "s4"}})
	if !HasBlockingIssue(issues) {
		t.Fatal("socks4 without host:port should be a blocking issue")
	}
	// failover with a bad strategy scalar → error.
	issues = ValidateChainShape([]*model.Proxy{{ID: 2, Kind: model.ProxyFailover, Name: "g", GroupStrategy: "nope"}})
	if !HasBlockingIssue(issues) {
		t.Fatal("failover with invalid strategy should be a blocking issue")
	}
	// socks4 with endpoint → ok.
	issues = ValidateChainShape([]*model.Proxy{{ID: 3, Kind: model.ProxySOCKS4, Name: "s4", Host: "h", Port: 1080}})
	if HasBlockingIssue(issues) {
		t.Fatalf("valid socks4 should pass, got %+v", issues)
	}
}

// countingDialer records dial calls so we can assert per-hop metering wiring.
type countingDialer struct{ dials int }

func (d *countingDialer) DialContext(_ context.Context, _, _ string) (net.Conn, error) {
	d.dials++
	a, b := net.Pipe()
	_ = a.Close()
	return b, nil
}

type recordingSink struct {
	dials   map[uint64]int
	opens   int
	closes  int
	bytesIn int64
}

func (s *recordingSink) OnDial(id uint64, _ bool, _ time.Duration) { s.dials[id]++ }
func (s *recordingSink) OnConnOpen(uint64)                          { s.opens++ }
func (s *recordingSink) OnConnClose(uint64)                         { s.closes++ }
func (s *recordingSink) AddBytes(_ uint64, in, _ int64)            { s.bytesIn += in }

func TestSOCKS5ContextPropagates(t *testing.T) {
	// The wzshiming dialer must call our upstream's DialContext (carrying ctx),
	// proving the old context-dropping adapter is gone. We cancel the ctx so the
	// dial fails fast through the upstream rather than hanging.
	var up countingDialer
	d, err := NewSOCKS5("127.0.0.1:1080", "", "", time.Second, &up)
	if err != nil {
		t.Fatalf("NewSOCKS5: %v", err)
	}
	ctx, cancel := context.WithCancel(context.Background())
	cancel()
	_, _ = d.DialContext(ctx, "tcp", "example:22")
	if up.dials == 0 {
		t.Fatal("upstream dialer was never invoked — context not threaded through")
	}
}

var _ proxy.ContextDialer = (*countingDialer)(nil)
