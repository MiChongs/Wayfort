package model

import "time"

type AuditEventKind string

const (
	AuditSessionStart    AuditEventKind = "session.start"
	AuditSessionEnd      AuditEventKind = "session.end"
	AuditCommand         AuditEventKind = "command"
	AuditResize          AuditEventKind = "resize"
	AuditFileUpload      AuditEventKind = "file.upload"
	AuditFileDownload    AuditEventKind = "file.download"
	AuditFileDelete      AuditEventKind = "file.delete"
	AuditFileRename      AuditEventKind = "file.rename"
	AuditFileChmod       AuditEventKind = "file.chmod"
	AuditFileMkdir       AuditEventKind = "file.mkdir"
	AuditFileWrite       AuditEventKind = "file.write"
	AuditLogin           AuditEventKind = "auth.login"
	AuditLoginFailed     AuditEventKind = "auth.login_failed"
	AuditAnonymousLaunch AuditEventKind = "anonymous.launch"
	AuditAnonymousReap   AuditEventKind = "anonymous.reap"
	AuditPortForwardOpen AuditEventKind = "portforward.open"
	AuditPortForwardClose AuditEventKind = "portforward.close"
	AuditGraphicalStart  AuditEventKind = "graphical.start"
	AuditGraphicalError  AuditEventKind = "graphical.error"
)

type AuditLog struct {
	ID        uint64         `gorm:"primaryKey" json:"id"`
	Kind      AuditEventKind `gorm:"size:64;index" json:"kind"`
	UserID    uint64         `gorm:"index" json:"user_id"`
	Username  string         `gorm:"size:64" json:"username"`
	SessionID string         `gorm:"size:64;index" json:"session_id,omitempty"`
	NodeID    *uint64        `json:"node_id,omitempty"`
	ClientIP  string         `gorm:"size:64" json:"client_ip"`
	Payload   string         `gorm:"type:text" json:"payload,omitempty"`
	CreatedAt time.Time      `gorm:"index" json:"created_at"`
}

func (AuditLog) TableName() string { return "audit_logs" }
