package model

import "time"

// SystemSetting is one persisted override of a managed configuration key.
//
// The gateway's configuration is split in two:
//
//   - Bootstrap keys (server.addr, db.dsn, redis.addr, auth.jwt_secret,
//     crypto.*, storage.sessions_dir, listener host/port ranges) stay in the
//     YAML file because they're needed before the database is even reachable,
//     or they bind sockets the process can't rebind without a restart.
//
//   - Managed keys (everything else — auth policy, MFA, AI tuning, SMTP,
//     desktop, protocol gateways, audit, …) live here. The YAML value seeds
//     the row on first boot; after that this table is the source of truth and
//     the settings center overlays it onto the in-memory config on every load.
//
// One row per managed key. Value holds the JSON encoding of the typed value
// (a string for durations like "1h30m", a bool, a number, a string array, or
// an object). For Secret keys the Value column instead holds the base64 of the
// bootstrap-sealed ciphertext and the plaintext is never read back over the
// API — only "configured / not configured" is surfaced.
type SystemSetting struct {
	Key       string    `gorm:"primaryKey;size:128" json:"key"`
	Value     string    `gorm:"type:text" json:"value"`
	Secret    bool      `gorm:"default:false" json:"secret"`
	UpdatedBy uint64    `json:"updated_by"`
	UpdatedAt time.Time `json:"updated_at"`
}

func (SystemSetting) TableName() string { return "system_settings" }

// SystemSettingAudit is an append-only trail of who changed which managed key
// and when. Secret values are stored masked ("••• → •••") so the trail never
// leaks the material it audits. Kept deliberately lightweight: the table backs
// the "最近修改" strip in the settings UI, not a full rollback engine.
type SystemSettingAudit struct {
	ID        uint64    `gorm:"primaryKey" json:"id"`
	Key       string    `gorm:"size:128;index" json:"key"`
	Group     string    `gorm:"size:64;index" json:"group"`
	OldValue  string    `gorm:"type:text" json:"old_value"`
	NewValue  string    `gorm:"type:text" json:"new_value"`
	ActorID   uint64    `json:"actor_id"`
	ActorName string    `gorm:"size:128" json:"actor_name"`
	CreatedAt time.Time `gorm:"index" json:"created_at"`
}

func (SystemSettingAudit) TableName() string { return "system_setting_audits" }
