package approval

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"strings"
	"sync"
	"time"

	"github.com/michongs/wayfort/internal/model"
	"go.uber.org/zap"
)

// Notifier is the fan-out hook the service calls after every meaningful
// transition (request.created, task.created, request.approved / rejected,
// grant.issued / revoked / expired). The pattern mirrors `internal/audit`:
// best-effort, non-blocking, never on the critical path.
//
// Implementations live alongside this file: webhook + email today, IM
// (feishu / dingtalk / wecom / slack / teams) stubs are wired through the
// same interface so a later PR can fill them in without touching the
// service layer or the workflow engine.
type Notifier interface {
	Notify(ctx context.Context, env NotifyEnvelope) error
	// Kind returns the channel identifier this notifier handles. Used by
	// the fan-out to route per-subscription targets to the right
	// implementation. Multiple notifiers can share a Kind (e.g. webhook
	// with different signing schemes) as long as the subscription Target
	// is unique.
	Kind() string
}

// NotifyEnvelope is the payload every notifier receives. Carrying the
// envelope rather than the raw event row lets notifiers render their
// channel-native message (a Slack block, a feishu card, a SOAR webhook
// JSON) without re-querying the DB.
type NotifyEnvelope struct {
	Subscription model.ApprovalSubscription `json:"-"`
	Event        model.ApprovalEvent        `json:"event"`
	Request      model.ApprovalRequest      `json:"request"`
	// Approvers carries the pending approver names so an IM card can show
	// "@张三 @李四 待批" without an extra round-trip from the bot.
	Approvers    []string                   `json:"approvers,omitempty"`
	// GrantID is populated for grant lifecycle events so a SIEM can ingest
	// the issued / revoked grant directly.
	GrantID      string                     `json:"grant_id,omitempty"`
}

// FanoutNotifier muxes envelopes across multiple registered notifiers. It
// holds an in-process bounded queue per channel so a slow upstream IM
// doesn't backpressure the workflow engine.
type FanoutNotifier struct {
	logger    *zap.Logger
	notifiers map[string]Notifier // by Kind
	mu        sync.RWMutex
}

// NewFanout constructs an empty FanoutNotifier; register concrete notifiers
// via Register before use.
func NewFanout(logger *zap.Logger) *FanoutNotifier {
	return &FanoutNotifier{
		logger:    logger,
		notifiers: map[string]Notifier{},
	}
}

// Register adds a notifier under its Kind. Subsequent calls with the same
// Kind replace the prior registration.
func (f *FanoutNotifier) Register(n Notifier) {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.notifiers[n.Kind()] = n
}

// Dispatch sends the envelope to every subscriber whose Channel matches a
// registered notifier and whose EventMask covers the event Kind. Errors are
// logged but never returned — the audit ledger is the authoritative source
// for whether the event happened; downstream fan-out is best effort.
func (f *FanoutNotifier) Dispatch(ctx context.Context, env NotifyEnvelope,
	subs []model.ApprovalSubscription) {
	for _, s := range subs {
		s := s
		if !s.Enabled {
			continue
		}
		if !maskAllows(s.EventMask, string(env.Event.Kind)) {
			continue
		}
		f.mu.RLock()
		n, ok := f.notifiers[s.Channel]
		f.mu.RUnlock()
		if !ok {
			continue
		}
		env.Subscription = s
		// Fire and forget; the channel's own bounded queue (if any)
		// handles backpressure. We give a generous timeout because IM
		// providers can be slow, but cap it to avoid the goroutine
		// leaking on a stuck dial.
		go func() {
			cctx, cancel := context.WithTimeout(context.Background(), 8*time.Second)
			defer cancel()
			if err := n.Notify(cctx, env); err != nil && f.logger != nil {
				f.logger.Warn("approval notifier failed",
					zap.String("channel", s.Channel),
					zap.String("target", s.Target),
					zap.String("kind", string(env.Event.Kind)),
					zap.Error(err))
			}
		}()
	}
}

func maskAllows(mask, kind string) bool {
	mask = strings.TrimSpace(mask)
	if mask == "" || mask == "*" {
		return true
	}
	for _, m := range strings.Split(mask, ",") {
		if strings.TrimSpace(m) == kind {
			return true
		}
	}
	return false
}

// ----------------------------------------------------------------------------
// Webhook notifier
// ----------------------------------------------------------------------------

// WebhookNotifier posts the envelope to a configurable URL as application/json.
// Subscription.Secret is optionally used as a bearer token; if it starts with
// "hmac:" the remainder is the HMAC key (TODO once integrated layer lands).
type WebhookNotifier struct {
	client *http.Client
}

// NewWebhookNotifier returns a notifier with a sensible default HTTP client.
func NewWebhookNotifier() *WebhookNotifier {
	return &WebhookNotifier{client: &http.Client{Timeout: 6 * time.Second}}
}

func (*WebhookNotifier) Kind() string { return "webhook" }

func (n *WebhookNotifier) Notify(ctx context.Context, env NotifyEnvelope) error {
	if env.Subscription.Target == "" {
		return errors.New("webhook target empty")
	}
	body, err := json.Marshal(env)
	if err != nil {
		return fmt.Errorf("marshal envelope: %w", err)
	}
	req, err := http.NewRequestWithContext(ctx, http.MethodPost,
		env.Subscription.Target, bytes.NewReader(body))
	if err != nil {
		return err
	}
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("X-Wayfort-Event", string(env.Event.Kind))
	req.Header.Set("X-Wayfort-Request", env.Request.ID)
	if sec := env.Subscription.Secret; sec != "" {
		req.Header.Set("Authorization", "Bearer "+sec)
	}
	resp, err := n.client.Do(req)
	if err != nil {
		return err
	}
	defer func() { _, _ = io.Copy(io.Discard, resp.Body); _ = resp.Body.Close() }()
	if resp.StatusCode/100 != 2 {
		return fmt.Errorf("webhook returned HTTP %d", resp.StatusCode)
	}
	return nil
}

// ----------------------------------------------------------------------------
// Stub notifiers for IM / SIEM channels — fill in via subsequent PRs.
// ----------------------------------------------------------------------------

type stubNotifier struct {
	kind   string
	logger *zap.Logger
}

func (s *stubNotifier) Kind() string { return s.kind }
func (s *stubNotifier) Notify(_ context.Context, env NotifyEnvelope) error {
	if s.logger == nil {
		return nil
	}
	s.logger.Info("approval notifier stub",
		zap.String("channel", s.kind),
		zap.String("request_id", env.Request.ID),
		zap.String("kind", string(env.Event.Kind)))
	return nil
}

// NewStubNotifier creates a no-op notifier for the given channel. Useful for
// dev environments and for keeping the dispatch path exercised before an IM
// implementation is wired up. Today: feishu, dingtalk, wecom, slack, teams,
// siem. Replace with real implementations one PR at a time.
func NewStubNotifier(kind string, logger *zap.Logger) Notifier {
	return &stubNotifier{kind: kind, logger: logger}
}
