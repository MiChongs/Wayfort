package model

import "time"

// NotificationKind identifies the event a notification is about. Kept as stable
// strings (not iota) so they survive migrations and read cleanly in the DB.
type NotificationKind string

const (
	NotifyKindAnomalyLogin  NotificationKind = "anomaly_login"  // a successful login flagged anomalous
	NotifyKindBruteForce    NotificationKind = "brute_force"    // a burst of failed attempts on an account/IP
	NotifyKindAccountLocked NotificationKind = "account_locked" // lockout policy tripped
	NotifyKindSecurity      NotificationKind = "security"       // generic security notice
	NotifyKindSystem        NotificationKind = "system"         // generic system notice
	NotifyKindBreakGlass    NotificationKind = "break_glass"    // emergency-access activation / revoke
)

// NotificationSeverity drives the UI accent (badge colour / icon).
type NotificationSeverity string

const (
	NotifySevInfo     NotificationSeverity = "info"
	NotifySevWarning  NotificationSeverity = "warning"
	NotifySevCritical NotificationSeverity = "critical"
)

// Notification is a persisted, per-recipient in-app message. The notification
// center lists these; a realtime hub pushes new rows to connected browsers over
// SSE. Data carries event-specific JSON metadata (ip, country, reasons, …) the
// UI can render without re-fetching.
type Notification struct {
	ID       uint64               `gorm:"primaryKey" json:"id"`
	UserID   uint64               `gorm:"not null;index:idx_notif_user_created,priority:1;index:idx_notif_user_read,priority:1" json:"user_id"`
	Kind     NotificationKind     `gorm:"size:48;index" json:"kind"`
	Severity NotificationSeverity `gorm:"size:16" json:"severity"`
	Title    string               `gorm:"size:200" json:"title"`
	Body     string               `gorm:"type:text" json:"body"`
	// Data is opaque JSON metadata about the event (rendered as detail chips).
	Data string `gorm:"type:text" json:"data,omitempty"`
	// Link is an in-app deep link the notification opens to (e.g. /me/login-history).
	Link string `gorm:"size:255" json:"link,omitempty"`
	// ReadAt is nil until the recipient marks it read.
	ReadAt    *time.Time `gorm:"index:idx_notif_user_read,priority:2" json:"read_at,omitempty"`
	CreatedAt time.Time  `gorm:"index:idx_notif_user_created,priority:2" json:"created_at"`
}

func (Notification) TableName() string { return "notifications" }
