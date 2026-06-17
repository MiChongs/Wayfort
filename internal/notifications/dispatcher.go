package notifications

import (
	"context"
	"encoding/json"
	"sync"
	"time"

	"github.com/michongs/wayfort/internal/auth"
	"github.com/michongs/wayfort/internal/model"
	"github.com/michongs/wayfort/internal/notify"
	"github.com/michongs/wayfort/internal/repo"
	"go.uber.org/zap"
)

// securityPermCodes are the permission codes whose holders make up "the security
// team" — the people an anomaly / brute-force alert should reach in addition to
// the affected user. is_admin bootstrap accounts are always included by the repo.
var securityPermCodes = []string{auth.PermSecurityManage, auth.PermAuditRead, auth.PermSystemAdmin}

// Recipient is a notification target: a user id and (optionally) their email.
type Recipient struct {
	UserID uint64
	Email  string
}

// Event is a higher-level notification request resolved by the Dispatcher into
// persisted rows, realtime pushes, and (optionally) emails.
type Event struct {
	Kind     model.NotificationKind
	Severity model.NotificationSeverity
	Title    string
	Body     string
	Link     string
	Data     map[string]any

	Recipients []Recipient

	// SendEmail emails recipients that have an address. Subject/HTML/Text default
	// to Title/Body when left empty.
	SendEmail    bool
	EmailSubject string
	EmailHTML    string
	EmailText    string

	// DebounceKey + DebounceWindow throttle repeat emails to the same recipient
	// for the same logical event (e.g. a compromised account flooding alerts).
	// Empty key defaults to the kind; a zero window disables debouncing.
	DebounceKey    string
	DebounceWindow time.Duration
}

// Dispatcher persists + pushes + emails notifications. It is nil-safe: a nil
// dispatcher (feature unwired) silently no-ops.
type Dispatcher struct {
	notif  *repo.NotificationRepo
	users  *repo.UserRepo
	mailer *notify.Mailer
	hub    *Hub
	logger *zap.Logger

	mu        sync.Mutex
	lastEmail map[string]time.Time // debounce: "userID|key" → last sent
}

func NewDispatcher(notif *repo.NotificationRepo, users *repo.UserRepo, mailer *notify.Mailer, hub *Hub, logger *zap.Logger) *Dispatcher {
	if logger == nil {
		logger = zap.NewNop()
	}
	return &Dispatcher{notif: notif, users: users, mailer: mailer, hub: hub, logger: logger, lastEmail: map[string]time.Time{}}
}

// Hub exposes the realtime fan-out for the SSE handler.
func (d *Dispatcher) Hub() *Hub {
	if d == nil {
		return nil
	}
	return d.hub
}

// SecurityRecipients resolves the current security team (admins + holders of
// security:manage / audit:read / system:admin) as notification recipients.
func (d *Dispatcher) SecurityRecipients(ctx context.Context) []Recipient {
	if d == nil || d.users == nil {
		return nil
	}
	users, err := d.users.ListByPermissionCodes(ctx, securityPermCodes)
	if err != nil {
		d.logger.Warn("notifications: resolve security recipients failed", zap.Error(err))
		return nil
	}
	out := make([]Recipient, 0, len(users))
	for _, u := range users {
		out = append(out, Recipient{UserID: u.ID, Email: u.Email})
	}
	return out
}

// Notify persists a notification per recipient, pushes it over the hub, and —
// when SendEmail is set — emails recipients that have an address (subject to
// debouncing). It never blocks on SMTP (the mailer queue is async) and tolerates
// a missing store/mailer. Recipients are de-duplicated by user id.
func (d *Dispatcher) Notify(ctx context.Context, ev Event) {
	if d == nil || len(ev.Recipients) == 0 {
		return
	}
	dataJSON := ""
	if len(ev.Data) > 0 {
		if b, err := json.Marshal(ev.Data); err == nil {
			dataJSON = string(b)
		}
	}
	debKey := ev.DebounceKey
	if debKey == "" {
		debKey = string(ev.Kind)
	}

	seen := make(map[uint64]struct{}, len(ev.Recipients))
	for _, r := range ev.Recipients {
		if r.UserID == 0 {
			continue
		}
		if _, dup := seen[r.UserID]; dup {
			continue
		}
		seen[r.UserID] = struct{}{}

		n := model.Notification{
			UserID:    r.UserID,
			Kind:      ev.Kind,
			Severity:  ev.Severity,
			Title:     ev.Title,
			Body:      ev.Body,
			Data:      dataJSON,
			Link:      ev.Link,
			CreatedAt: time.Now(),
		}
		if d.notif != nil {
			if err := d.notif.Insert(ctx, &n); err != nil {
				d.logger.Warn("notifications: persist failed", zap.Uint64("user", r.UserID), zap.Error(err))
			}
		}
		// Push the (now id-stamped) row to any connected browser.
		d.hub.Publish(n)

		if ev.SendEmail && r.Email != "" && d.mailer != nil && d.allowEmail(r.UserID, debKey, ev.DebounceWindow) {
			subject := ev.EmailSubject
			if subject == "" {
				subject = "[Wayfort] " + ev.Title
			}
			html := ev.EmailHTML
			text := ev.EmailText
			if html == "" && text == "" {
				text = ev.Body
			}
			d.mailer.Send(notify.Message{To: []string{r.Email}, Subject: subject, HTML: html, Text: text})
		}
	}
}

// allowEmail returns true when no email for (user, key) has been sent inside the
// debounce window, recording the send time when it returns true.
func (d *Dispatcher) allowEmail(userID uint64, key string, window time.Duration) bool {
	if window <= 0 {
		return true
	}
	id := key + "|" + itoa(userID)
	now := time.Now()
	d.mu.Lock()
	defer d.mu.Unlock()
	if last, ok := d.lastEmail[id]; ok && now.Sub(last) < window {
		return false
	}
	d.lastEmail[id] = now
	// Opportunistic cleanup so the map can't grow unbounded across long uptimes.
	if len(d.lastEmail) > 4096 {
		for k, t := range d.lastEmail {
			if now.Sub(t) > window {
				delete(d.lastEmail, k)
			}
		}
		// Hard ceiling: if a flood of unique (user,key) pairs within the window
		// outpaces expiry, reset to bound memory (worst case: a few duplicate
		// emails right after the reset).
		if len(d.lastEmail) > 8192 {
			d.lastEmail = map[string]time.Time{}
		}
	}
	return true
}

func itoa(v uint64) string {
	if v == 0 {
		return "0"
	}
	var buf [20]byte
	i := len(buf)
	for v > 0 {
		i--
		buf[i] = byte('0' + v%10)
		v /= 10
	}
	return string(buf[i:])
}
