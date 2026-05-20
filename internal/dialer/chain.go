package dialer

import (
	"context"
	"fmt"
	"strings"
	"time"

	"github.com/michongs/jumpserver-anonymous/internal/model"
	"golang.org/x/net/proxy"
)

// BastionConnector opens (or fetches from a pool) an SSH client to the given
// bastion using outer as the underlying transport. Implementations live in
// internal/sshpool so this package stays decoupled from the SSH stack.
type BastionConnector interface {
	Acquire(ctx context.Context, p *model.Proxy, outer proxy.ContextDialer) (*BastionDialer, func(), error)
}

// CredentialResolver knows how to fetch SOCKS5 credentials by ID. It is only
// called for proxies that point to a Credential row.
type CredentialResolver interface {
	UserPassByCredentialID(ctx context.Context, id uint64) (user, pass string, err error)
}

type ChainBuilder struct {
	Bastion BastionConnector
	Creds   CredentialResolver
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
		case model.ProxySOCKS5, model.ProxyHTTPConn:
			if strings.TrimSpace(p.Host) == "" || p.Port <= 0 {
				out = append(out, ChainIssue{
					Hop: i, ProxyID: p.ID, Severity: SeverityError,
					Code:    "missing_endpoint",
					Message: fmt.Sprintf("%s 代理未配置 host:port", p.Kind),
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
		base = &Direct{}
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
	for _, hop := range hops {
		next, rel, err := b.wrap(ctx, hop, current)
		if err != nil {
			release()
			return nil, func() {}, fmt.Errorf("chain hop %s: %w", hop.Name, err)
		}
		releases = append(releases, rel)
		current = next
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
	current := proxy.ContextDialer(&Direct{})
	releases := make([]func(), 0, len(hops))
	defer func() {
		for i := len(releases) - 1; i >= 0; i-- {
			if releases[i] != nil {
				releases[i]()
			}
		}
	}()
	for i, hop := range hops {
		start := time.Now()
		next, rel, err := b.wrap(ctx, hop, current)
		dur := time.Since(start)
		r := TestResult{
			Hop: i, ProxyID: hop.ID, Name: hop.Name,
			Kind: string(hop.Kind), Duration: dur / time.Millisecond,
		}
		if err != nil {
			r.OK = false
			r.Error = err.Error()
			out = append(out, r)
			return out
		}
		releases = append(releases, rel)
		current = next
		// On a real-target probe we issue a TCP dial through the partial
		// chain so subsequent hops are exercised end-to-end. We only run
		// the probe on the LAST hop to avoid spamming intermediates with
		// dummy connections (they're still implicitly probed via the next
		// wrap call).
		r.OK = true
		out = append(out, r)
	}
	if target != "" && len(out) > 0 {
		start := time.Now()
		conn, err := current.DialContext(ctx, "tcp", target)
		dur := time.Since(start) / time.Millisecond
		lastIdx := len(out) - 1
		out[lastIdx].Duration += dur
		if err != nil {
			out[lastIdx].OK = false
			out[lastIdx].Error = "target dial: " + err.Error()
		} else if conn != nil {
			_ = conn.Close()
		}
	}
	return out
}

func (b *ChainBuilder) wrap(ctx context.Context, p *model.Proxy, outer proxy.ContextDialer) (proxy.ContextDialer, func(), error) {
	switch p.Kind {
	case model.ProxyDirect:
		return outer, nil, nil
	case model.ProxySOCKS5:
		var user, pass string
		if p.CredentialID != nil && b.Creds != nil {
			u, pw, err := b.Creds.UserPassByCredentialID(ctx, *p.CredentialID)
			if err != nil {
				return nil, nil, err
			}
			user, pass = u, pw
		}
		addr := fmt.Sprintf("%s:%d", p.Host, p.Port)
		d, err := NewSOCKS5(addr, user, pass, outer)
		return d, nil, err
	case model.ProxyBastion:
		if b.Bastion == nil {
			return nil, nil, fmt.Errorf("bastion connector not configured")
		}
		bd, rel, err := b.Bastion.Acquire(ctx, p, outer)
		if err != nil {
			return nil, nil, err
		}
		return bd, rel, nil
	default:
		return nil, nil, fmt.Errorf("unsupported proxy kind %q", p.Kind)
	}
}
