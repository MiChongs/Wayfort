package export

import (
	"bytes"
	"context"
	"crypto/hmac"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"net/http"
	"time"

	"github.com/michongs/jumpserver-anonymous/internal/model"
)

// WebhookSink POSTs each event as JSON to a URL, signed with HMAC-SHA256 over
// the body so the receiver can verify authenticity. The JSON carries the
// chain_id + entry_hash for cross-verification against the integrity report.
type WebhookSink struct {
	url    string
	secret []byte
	client *http.Client
}

// NewWebhookSink builds a webhook sink. secret may be empty (then no signature
// header is sent).
func NewWebhookSink(url, secret string) *WebhookSink {
	return &WebhookSink{
		url:    url,
		secret: []byte(secret),
		client: &http.Client{Timeout: 10 * time.Second},
	}
}

func (s *WebhookSink) Name() string { return "webhook" }

// webhookPayload is the explicit, stable shape sent to receivers (not the raw
// GORM model, so column renames don't break integrations).
type webhookPayload struct {
	Kind       string `json:"kind"`
	UserID     uint64 `json:"user_id"`
	Username   string `json:"username"`
	SessionID  string `json:"session_id,omitempty"`
	NodeID     uint64 `json:"node_id,omitempty"`
	ClientIP   string `json:"client_ip,omitempty"`
	Payload    string `json:"payload,omitempty"`
	Category   string `json:"category"`
	Abnormal   bool   `json:"abnormal"`
	CreatedAt  string `json:"created_at"`
	ChainID    string `json:"chain_id,omitempty"`
	EntryHash  string `json:"entry_hash,omitempty"`
}

func (s *WebhookSink) Send(ctx context.Context, ev model.AuditLog) error {
	p := webhookPayload{
		Kind: string(ev.Kind), UserID: ev.UserID, Username: ev.Username,
		SessionID: ev.SessionID, ClientIP: ev.ClientIP, Payload: ev.Payload,
		Category: model.AuditCategoryOf(string(ev.Kind)), Abnormal: ev.IsAbnormal(),
		CreatedAt: ev.CreatedAt.UTC().Format(time.RFC3339),
		ChainID:   ev.ChainID, EntryHash: ev.EntryHash,
	}
	if ev.NodeID != nil {
		p.NodeID = *ev.NodeID
	}
	body, err := json.Marshal(p)
	if err != nil {
		return err
	}
	req, err := http.NewRequestWithContext(ctx, http.MethodPost, s.url, bytes.NewReader(body))
	if err != nil {
		return err
	}
	req.Header.Set("Content-Type", "application/json")
	if len(s.secret) > 0 {
		mac := hmac.New(sha256.New, s.secret)
		mac.Write(body)
		req.Header.Set("X-JumpServer-Signature", "sha256="+hex.EncodeToString(mac.Sum(nil)))
	}
	resp, err := s.client.Do(req)
	if err != nil {
		return fmt.Errorf("webhook post: %w", err)
	}
	defer resp.Body.Close()
	if resp.StatusCode >= 300 {
		return fmt.Errorf("webhook returned %s", resp.Status)
	}
	return nil
}
