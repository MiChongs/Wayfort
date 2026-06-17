package dialer

import (
	"context"
	"fmt"
	"net/http"
	"strings"
	"time"

	"github.com/michongs/wayfort/internal/model"
	"golang.org/x/net/proxy"
)

// BastionConnector opens (or fetches from a pool) an SSH client to the given
// bastion using outer as the underlying transport. Implementations live in
// internal/sshpool so this package stays decoupled from the SSH stack.
//
// outerKey is an opaque fingerprint of the chain that precedes this bastion
// (the hops to the left of it). The pool MUST fold it into its connection key
// so a client established over one front chain is never reused for a request
// that resolved to a different front chain — even when the bastion endpoint and
// credentials are identical. Two domains with an identical proxy chain produce
// the same key (the path is literally the same), which is the intended reuse.
type BastionConnector interface {
	Acquire(ctx context.Context, p *model.Proxy, outer proxy.ContextDialer, outerKey string) (*BastionDialer, func(), error)
}

// CredentialResolver knows how to fetch SOCKS5 credentials by ID. It is only
// called for proxies that point to a Credential row.
type CredentialResolver interface {
	UserPassByCredentialID(ctx context.Context, id uint64) (user, pass string, err error)
}

// defaultHopTimeout is the fallback per-hop connect deadline when neither the
// proxy row nor the builder configures one. A bounded default replaces the old
// zero-value Direct{} that connected with no timeout at all.
const defaultHopTimeout = 15 * time.Second

type ChainBuilder struct {
	Bastion BastionConnector
	Creds   CredentialResolver
	// Groups resolves failover-group members. Nil disables failover hops.
	Groups GroupReader
	// Health feeds failover member selection. Nil → treat all members healthy.
	Health HealthReader
	// Metrics receives dial/conn/byte telemetry. Nil disables instrumentation.
	Metrics MetricsSink
	// DefaultHopTimeout bounds each hop's connect when the proxy row leaves
	// TimeoutMS at 0. Zero falls back to defaultHopTimeout.
	DefaultHopTimeout time.Duration
}

// hopTimeout resolves the connect deadline for reaching one hop: the proxy's own
// TimeoutMS, else the builder default, else defaultHopTimeout.
func (b *ChainBuilder) hopTimeout(p *model.Proxy) time.Duration {
	if p != nil && p.TimeoutMS > 0 {
		return time.Duration(p.TimeoutMS) * time.Millisecond
	}
	if b.DefaultHopTimeout > 0 {
		return b.DefaultHopTimeout
	}
	return defaultHopTimeout
}

// meter wraps outer so the dial that reaches proxyID's server is timed/counted.
// No-op when metrics are disabled.
func (b *ChainBuilder) meter(outer proxy.ContextDialer, proxyID uint64) proxy.ContextDialer {
	if b.Metrics == nil {
		return outer
	}
	return &dialMeter{inner: outer, sink: b.Metrics, proxyID: proxyID}
}

// socksCreds resolves the optional username/password bound to a proxy hop.
func (b *ChainBuilder) socksCreds(ctx context.Context, p *model.Proxy) (user, pass string, err error) {
	if p.CredentialID != nil && b.Creds != nil {
		return b.Creds.UserPassByCredentialID(ctx, *p.CredentialID)
	}
	return "", "", nil
}

func headerFromMap(m map[string]string) http.Header {
	if len(m) == 0 {
		return nil
	}
	h := make(http.Header, len(m))
	for k, v := range m {
		h.Set(k, v)
	}
	return h
}

// MaxChainHops is a defence-in-depth limit so an operator can't accidentally
// stitch 50 hops together and exhaust the connection pool. Production chains
// almost always live within 1–3 hops; anything beyond 6 is a strong signal
// the chain was misconfigured or maliciously injected.
const MaxChainHops = 8

// ValidateChainShape runs the cheap, non-IO checks every chain should pass
// before we accept it: hop count, kind allow-list, disabled hops, duplicate
// proxy IDs (a cycle through the catalog), and bastion-needs-credential.
// Pure function — safe to call from validate endpoints and from Build itself
// as a guardrail. Returns a list of issues so the UI can render every problem
// at once rather than one-at-a-time.
func ValidateChainShape(hops []*model.Proxy) []ChainIssue {
	if len(hops) == 0 {
		return nil
	}
	out := make([]ChainIssue, 0, len(hops))
	if len(hops) > MaxChainHops {
		out = append(out, ChainIssue{
			Hop:      -1,
			Severity: SeverityError,
			Code:     "too_many_hops",
			Message:  fmt.Sprintf("链长 %d 超过上限 %d", len(hops), MaxChainHops),
		})
	}
	seen := make(map[uint64]int, len(hops))
	for i, p := range hops {
		if p == nil {
			out = append(out, ChainIssue{Hop: i, Severity: SeverityError, Code: "nil_hop", Message: "代理为空"})
			continue
		}
		if first, dup := seen[p.ID]; dup {
			out = append(out, ChainIssue{
				Hop:      i,
				ProxyID:  p.ID,
				Severity: SeverityError,
				Code:     "cycle",
				Message:  fmt.Sprintf("代理 %q 已在第 %d 跳出现,链存在环路", p.Name, first+1),
			})
		}
		seen[p.ID] = i
		if p.Disabled {
			out = append(out, ChainIssue{
				Hop:      i,
				ProxyID:  p.ID,
				Severity: SeverityWarning,
				Code:     "disabled",
				Message:  fmt.Sprintf("代理 %q 已禁用,会话可能失败", p.Name),
			})
		}
		switch p.Kind {
		case model.ProxyDirect:
			// direct is a no-op hop; lint as info only when it sits between others
			if i != 0 && i != len(hops)-1 {
				out = append(out, ChainIssue{
					Hop: i, ProxyID: p.ID, Severity: SeverityInfo,
					Code:    "direct_in_middle",
					Message: "direct 代理夹在中间没有意义,可移除",
				})
			}
		case model.ProxySOCKS5, model.ProxySOCKS4, model.ProxyHTTPConn:
			if strings.TrimSpace(p.Host) == "" || p.Port <= 0 {
				out = append(out, ChainIssue{
					Hop: i, ProxyID: p.ID, Severity: SeverityError,
					Code:    "missing_endpoint",
					Message: fmt.Sprintf("%s 代理未配置 host:port", p.Kind),
				})
			}
		case model.ProxyFailover:
			// Members are validated when the group is built (they live in a
			// separate table not visible here); only lint the strategy scalar.
			if p.GroupStrategy != "" && !p.GroupStrategy.Valid() {
				out = append(out, ChainIssue{
					Hop: i, ProxyID: p.ID, Severity: SeverityError,
					Code:    "bad_strategy",
					Message: fmt.Sprintf("故障转移组策略 %q 无效", p.GroupStrategy),
				})
			}
		case model.ProxyBastion:
			if strings.TrimSpace(p.Host) == "" || p.Port <= 0 {
				out = append(out, ChainIssue{
					Hop: i, ProxyID: p.ID, Severity: SeverityError,
					Code:    "missing_endpoint",
					Message: "bastion 代理未配置 host:port",
				})
			}
			if p.CredentialID == nil {
				out = append(out, ChainIssue{
					Hop: i, ProxyID: p.ID, Severity: SeverityError,
					Code:    "bastion_no_credential",
					Message: "bastion 代理必须绑定凭据",
				})
			}
		default:
			out = append(out, ChainIssue{
				Hop: i, ProxyID: p.ID, Severity: SeverityError,
				Code:    "unsupported_kind",
				Message: fmt.Sprintf("不支持的代理类型 %q", p.Kind),
			})
		}
	}
	return out
}

// HasBlockingIssue reports whether the issue list contains at least one
// SeverityError entry — the caller should refuse to dial the chain.
func HasBlockingIssue(issues []ChainIssue) bool {
	for _, i := range issues {
		if i.Severity == SeverityError {
			return true
		}
	}
	return false
}

// ChainIssue describes one lint finding produced by ValidateChainShape. The
// API serialises this verbatim so the UI can render warnings inline next to
// the offending hop.
type ChainIssue struct {
	Hop      int          `json:"hop"`
	ProxyID  uint64       `json:"proxy_id,omitempty"`
	Severity IssueSeverity `json:"severity"`
	Code     string       `json:"code"`
	Message  string       `json:"message"`
}

type IssueSeverity string

const (
	SeverityError   IssueSeverity = "error"
	SeverityWarning IssueSeverity = "warning"
	SeverityInfo    IssueSeverity = "info"
)

// Build composes the chain of proxies and returns a ContextDialer that, when
// used, will tunnel through every hop in order. release MUST be called once
// the resulting dialer is no longer needed so bastion clients can decrement
// their refcounts. release is safe to call exactly once and is never nil.
func (b *ChainBuilder) Build(ctx context.Context, hops []*model.Proxy, base proxy.ContextDialer) (proxy.ContextDialer, func(), error) {
	if issues := ValidateChainShape(hops); HasBlockingIssue(issues) {
		return nil, func() {}, fmt.Errorf("chain validation: %s", issues[0].Message)
	}
	if base == nil {
		// A bounded Direct base fixes the old zero-value Direct{} that connected
		// with no timeout at all.
		base = &Direct{Timeout: b.hopTimeout(nil)}
	}
	releases := make([]func(), 0, len(hops))
	release := func() {
		// Release in reverse order so inner clients drop their refs before the
		// outer transports they depend on are torn down.
		for i := len(releases) - 1; i >= 0; i-- {
			if releases[i] != nil {
				releases[i]()
			}
		}
	}
	current := base
	// outerKey accumulates the identity of the hops to the left of the current
	// one, so a bastion's pooled client is keyed by its full upstream path.
	outerKey := ""
	for _, hop := range hops {
		next, rel, err := b.wrap(ctx, hop, current, outerKey)
		if err != nil {
			release()
			return nil, func() {}, fmt.Errorf("chain hop %s: %w", hop.Name, err)
		}
		releases = append(releases, rel)
		current = next
		outerKey = appendHopKey(outerKey, hop)
	}
	// Outermost byte/active-conn metering, attributed to the egress (terminal)
	// hop so session traffic is counted exactly once.
	if b.Metrics != nil {
		var termID uint64
		if n := len(hops); n > 0 {
			termID = hops[n-1].ID
		}
		current = &connMeter{inner: current, sink: b.Metrics, terminalID: termID}
	}
	return current, release, nil
}

// TestResult is one hop's outcome from a probe of the chain. The handler
// surfaces the slice verbatim so the UI can render a per-hop status badge.
type TestResult struct {
	Hop      int           `json:"hop"`
	ProxyID  uint64        `json:"proxy_id"`
	Name     string        `json:"name"`
	Kind     string        `json:"kind"`
	OK       bool          `json:"ok"`
	Duration time.Duration `json:"duration_ms"`
	Error    string        `json:"error,omitempty"`
	// Probed is the host:port actually dialed through the partial chain for this
	// hop (the next hop's endpoint, or this hop's own for the last hop). Empty
	// when the hop could only be built, not dialed (e.g. a failover next hop).
	Probed string `json:"probed,omitempty"`
}

// Test probes the chain end-to-end. It walks the hops just like Build, but on
// each successfully wrapped hop it attempts a TCP probe to target through the
// partial chain to confirm reachability. The whole probe is bounded by ctx.
// If target is empty the test stops at "could build the chain" without a
// downstream dial.
func (b *ChainBuilder) Test(ctx context.Context, hops []*model.Proxy, target string) []TestResult {
	out := make([]TestResult, 0, len(hops))
	if issues := ValidateChainShape(hops); HasBlockingIssue(issues) {
		// surface the lint error in the first hop slot so the UI shows
		// _something_ rather than an empty list
		first := issues[0]
		out = append(out, TestResult{
			Hop: first.Hop, ProxyID: first.ProxyID, OK: false,
			Error: first.Message,
		})
		return out
	}
	// Probe with a metrics-free builder so test dials never pollute live
	// session counters.
	pb := *b
	pb.Metrics = nil
	for i := range hops {
		hop := hops[i]
		r := TestResult{Hop: i, ProxyID: hop.ID, Name: hop.Name, Kind: string(hop.Kind)}
		// Build the partial chain hops[:i+1] and issue a real dial through it so
		// lazy SOCKS/HTTP dialers actually perform their handshake — the old
		// code marked them OK on wrap() return without ever connecting.
		partial, release, err := pb.Build(ctx, hops[:i+1], nil)
		if err != nil {
			r.OK = false
			r.Error = err.Error()
			out = append(out, r)
			return out
		}
		probe := strings.TrimSpace(target)
		if probe == "" {
			probe = probeTargetFor(hops, i)
		}
		start := time.Now()
		var dialErr error
		if probe != "" {
			conn, e := partial.DialContext(ctx, "tcp", probe)
			dialErr = e
			if conn != nil {
				_ = conn.Close()
			}
		}
		r.Duration = time.Since(start) / time.Millisecond
		release()
		if dialErr != nil {
			r.OK = false
			r.Error = dialErr.Error()
			r.Probed = probe
			out = append(out, r)
			return out
		}
		r.OK = true
		r.Probed = probe
		out = append(out, r)
	}
	return out
}

// probeTargetFor picks a host:port to dial through the partial chain ending at
// hop i: the next hop's endpoint (proves hop i reaches it), falling back to hop
// i's own endpoint for the last hop. Returns "" when neither has an endpoint
// (e.g. a failover next hop) — the caller then only validates the build.
func probeTargetFor(hops []*model.Proxy, i int) string {
	if i+1 < len(hops) {
		if t := endpointOf(hops[i+1]); t != "" {
			return t
		}
	}
	return endpointOf(hops[i])
}

func endpointOf(p *model.Proxy) string {
	if p == nil || strings.TrimSpace(p.Host) == "" || p.Port <= 0 {
		return ""
	}
	return fmt.Sprintf("%s:%d", p.Host, p.Port)
}

// appendHopKey extends the cumulative outer-chain identity with one hop. Uses
// the proxy id (stable, unique per catalog row) plus endpoint so two distinct
// hops can never collide. Format is opaque to callers — only equality matters.
func appendHopKey(prev string, p *model.Proxy) string {
	if p == nil {
		return prev + "nil>"
	}
	return prev + fmt.Sprintf("%d@%s:%d>", p.ID, p.Host, p.Port)
}

func (b *ChainBuilder) wrap(ctx context.Context, p *model.Proxy, outer proxy.ContextDialer, outerKey string) (proxy.ContextDialer, func(), error) {
	to := b.hopTimeout(p)
	addr := fmt.Sprintf("%s:%d", p.Host, p.Port)
	switch p.Kind {
	case model.ProxyDirect:
		return outer, nil, nil
	case model.ProxySOCKS5:
		user, pass, err := b.socksCreds(ctx, p)
		if err != nil {
			return nil, nil, err
		}
		d, err := NewSOCKS5(addr, user, pass, to, b.meter(outer, p.ID))
		return d, nil, err
	case model.ProxySOCKS4:
		// SOCKS4 carries only an ident (username); password is ignored.
		user, _, err := b.socksCreds(ctx, p)
		if err != nil {
			return nil, nil, err
		}
		d, err := NewSOCKS4(addr, user, p.SOCKS4Remote, to, b.meter(outer, p.ID))
		return d, nil, err
	case model.ProxyHTTPConn:
		user, pass, err := b.socksCreds(ctx, p)
		if err != nil {
			return nil, nil, err
		}
		d, err := NewHTTPConnect(addr, user, pass, p.TLSToProxy, p.ProxySNI, p.InsecureSkipVerify, headerFromMap(p.Headers), to, b.meter(outer, p.ID))
		return d, nil, err
	case model.ProxyBastion:
		if b.Bastion == nil {
			return nil, nil, fmt.Errorf("bastion connector not configured")
		}
		bd, rel, err := b.Bastion.Acquire(ctx, p, b.meter(outer, p.ID), outerKey)
		if err != nil {
			return nil, nil, err
		}
		return bd, rel, nil
	case model.ProxyFailover:
		return b.wrapGroup(ctx, p, outer, outerKey)
	default:
		return nil, nil, fmt.Errorf("unsupported proxy kind %q", p.Kind)
	}
}

// wrapGroup turns a failover hop into a failoverDialer. Each member is composed
// over the SAME outer (the chain branches at the group hop, which is the correct
// failover semantic: any member is an alternative path forward). Broken members
// are skipped; the group fails only when none are usable. Nested groups are
// rejected to bound recursion.
func (b *ChainBuilder) wrapGroup(ctx context.Context, p *model.Proxy, outer proxy.ContextDialer, outerKey string) (proxy.ContextDialer, func(), error) {
	if b.Groups == nil {
		return nil, nil, fmt.Errorf("failover group reader not configured")
	}
	specs, err := b.Groups.MembersOf(ctx, p.ID)
	if err != nil {
		return nil, nil, err
	}
	built := make([]builtMember, 0, len(specs))
	releases := make([]func(), 0, len(specs))
	for _, s := range specs {
		if s.Proxy == nil || s.Proxy.Disabled || s.Proxy.Kind == model.ProxyFailover {
			continue
		}
		// All members share the group's upstream, so they get the same outerKey;
		// each member's own endpoint still distinguishes its pooled client.
		d, rel, werr := b.wrap(ctx, s.Proxy, outer, outerKey)
		if werr != nil {
			continue // skip a broken member rather than sinking the group
		}
		if rel != nil {
			releases = append(releases, rel)
		}
		built = append(built, builtMember{
			proxyID: s.Proxy.ID, priority: s.Priority, weight: s.Weight, dialer: d,
		})
	}
	if len(built) == 0 {
		for i := len(releases) - 1; i >= 0; i-- {
			releases[i]()
		}
		return nil, nil, fmt.Errorf("failover group %q has no usable members", p.Name)
	}
	backoff := time.Duration(p.GroupBackoffMS) * time.Millisecond
	backoffMax := backoff * 16
	if backoffMax <= 0 || backoffMax > 30*time.Second {
		backoffMax = 30 * time.Second
	}
	fd := &failoverDialer{
		groupID:     p.ID,
		members:     built,
		strategy:    p.GroupStrategy,
		retryMax:    p.GroupRetryMax,
		backoffBase: backoff,
		backoffMax:  backoffMax,
		health:      b.Health,
		metrics:     b.Metrics,
	}
	release := func() {
		for i := len(releases) - 1; i >= 0; i-- {
			if releases[i] != nil {
				releases[i]()
			}
		}
	}
	return fd, release, nil
}
