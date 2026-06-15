package export

import (
	"context"
	"crypto/hmac"
	"crypto/sha256"
	"encoding/hex"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/michongs/jumpserver-anonymous/internal/model"
	"go.uber.org/zap"
)

func sampleEvent() model.AuditLog {
	return model.AuditLog{
		Kind: model.AuditCommand, UserID: 7, Username: "alice",
		SessionID: "sess-1", ClientIP: "10.0.0.5", Payload: "rm -rf /tmp/x",
		CreatedAt: time.Unix(1700000000, 0),
		ChainID:   "inst-1", EntryHash: "abc123",
	}
}

func TestFormatCEF_HeaderAndChainFields(t *testing.T) {
	line := FormatCEF(sampleEvent())
	if !strings.HasPrefix(line, "CEF:0|JumpServer|Gateway|1.0|command|command|") {
		t.Fatalf("unexpected CEF header: %s", line)
	}
	for _, want := range []string{
		"suser=alice", "src=10.0.0.5", "act=command",
		"cs1Label=chainId", "cs1=inst-1",
		"cs2Label=entryHash", "cs2=abc123",
		"externalId=sess-1",
	} {
		if !strings.Contains(line, want) {
			t.Fatalf("CEF line missing %q\n%s", want, line)
		}
	}
}

func TestFormatCEF_EscapesValues(t *testing.T) {
	ev := sampleEvent()
	ev.Payload = "a=b\nc" // '=' and newline must be escaped in the extension
	line := FormatCEF(ev)
	if !strings.Contains(line, `msg=a\=b\nc`) {
		t.Fatalf("value not escaped: %s", line)
	}
}

// recordingSink captures delivered events.
type recordingSink struct {
	mu   sync.Mutex
	got  []model.AuditLog
}

func (r *recordingSink) Name() string { return "rec" }
func (r *recordingSink) Send(_ context.Context, ev model.AuditLog) error {
	r.mu.Lock()
	r.got = append(r.got, ev)
	r.mu.Unlock()
	return nil
}
func (r *recordingSink) count() int {
	r.mu.Lock()
	defer r.mu.Unlock()
	return len(r.got)
}

func TestExporter_FansToSink(t *testing.T) {
	rec := &recordingSink{}
	exp := NewExporter([]Sink{rec}, 16, zap.NewNop())
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	go exp.Run(ctx)

	exp.Fan([]model.AuditLog{sampleEvent(), sampleEvent()})

	deadline := time.Now().Add(2 * time.Second)
	for rec.count() < 2 && time.Now().Before(deadline) {
		time.Sleep(5 * time.Millisecond)
	}
	if rec.count() != 2 {
		t.Fatalf("sink should have received 2 events, got %d", rec.count())
	}
}

func TestExporter_DropsWhenQueueFull(t *testing.T) {
	rec := &recordingSink{}
	// queueSize 2, NO runner started → the queue fills and further events drop.
	exp := NewExporter([]Sink{rec}, 2, zap.NewNop())
	batch := make([]model.AuditLog, 10)
	for i := range batch {
		batch[i] = sampleEvent()
	}
	exp.Fan(batch)
	if exp.DroppedTotal() == 0 {
		t.Fatal("a full sink queue must drop + count, never block")
	}
}

func TestWebhookSink_SignsBody(t *testing.T) {
	secret := "hook-secret"
	var gotSig string
	var gotBody []byte
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		gotSig = r.Header.Get("X-JumpServer-Signature")
		gotBody, _ = io.ReadAll(r.Body)
		w.WriteHeader(http.StatusOK)
	}))
	defer srv.Close()

	sink := NewWebhookSink(srv.URL, secret)
	if err := sink.Send(context.Background(), sampleEvent()); err != nil {
		t.Fatalf("send: %v", err)
	}
	mac := hmac.New(sha256.New, []byte(secret))
	mac.Write(gotBody)
	want := "sha256=" + hex.EncodeToString(mac.Sum(nil))
	if gotSig != want {
		t.Fatalf("HMAC mismatch:\n got %s\nwant %s", gotSig, want)
	}
	if !strings.Contains(string(gotBody), `"entry_hash":"abc123"`) {
		t.Fatalf("webhook body must carry entry_hash for cross-verify: %s", gotBody)
	}
}
