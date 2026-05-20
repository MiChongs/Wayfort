package model

import "time"

// Phase 15 — Approval Service.
//
// Approval is intentionally factored out of every action-bearing module (SSH,
// RDP, credentials, file transfer, …) and concentrated into one append-only
// domain. Each Request is the unit of work: a user wants to do a high-risk
// thing against a resource within a time window. The engine drives the
// Request through one or more Tasks (per approver / per stage) and finally
// either issues a time-bound Grant or denies it. Every transition is appended
// to the audit Ledger so it's tamper-evident.

// ApprovalBusinessType discriminates what the requester is asking for. The
// engine, the policy, and the integration layer all branch off it.
type ApprovalBusinessType string

const (
	ApprovalBizAssetAccess    ApprovalBusinessType = "asset_access"     // 资产访问审批
	ApprovalBizCredentialUse  ApprovalBusinessType = "credential_use"   // 凭据使用审批
	ApprovalBizCommandExec    ApprovalBusinessType = "command_exec"     // 命令执行审批
	ApprovalBizSQLExec        ApprovalBusinessType = "sql_exec"         // SQL 执行审批
	ApprovalBizFileTransfer   ApprovalBusinessType = "file_transfer"    // 文件传输审批
	ApprovalBizSessionExtend  ApprovalBusinessType = "session_extend"   // 会话续期审批
	ApprovalBizSessionElevate ApprovalBusinessType = "session_elevate"  // 会话提权审批
	ApprovalBizBreakGlass     ApprovalBusinessType = "break_glass"      // 应急访问
	ApprovalBizVendorAccess   ApprovalBusinessType = "vendor_access"    // 第三方厂商访问
	ApprovalBizAuditView      ApprovalBusinessType = "audit_view"       // 审计查看审批
)

// ApprovalRequestStatus is the terminal-or-running status of a Request.
type ApprovalRequestStatus string

const (
	ApprovalReqPending   ApprovalRequestStatus = "pending"
	ApprovalReqApproved  ApprovalRequestStatus = "approved"
	ApprovalReqRejected  ApprovalRequestStatus = "rejected"
	ApprovalReqCancelled ApprovalRequestStatus = "cancelled"
	ApprovalReqExpired   ApprovalRequestStatus = "expired"
	ApprovalReqAutoApproved ApprovalRequestStatus = "auto_approved"
)

// ApprovalRiskLevel is the policy-computed risk tier; used both for routing
// and for picking SLA / escalation chains.
type ApprovalRiskLevel string

const (
	ApprovalRiskLow      ApprovalRiskLevel = "low"
	ApprovalRiskMedium   ApprovalRiskLevel = "medium"
	ApprovalRiskHigh     ApprovalRiskLevel = "high"
	ApprovalRiskCritical ApprovalRiskLevel = "critical"
)

// ApprovalTaskState describes one approver's slot inside a Request.
type ApprovalTaskState string

const (
	ApprovalTaskPending   ApprovalTaskState = "pending"
	ApprovalTaskApproved  ApprovalTaskState = "approved"
	ApprovalTaskRejected  ApprovalTaskState = "rejected"
	ApprovalTaskDelegated ApprovalTaskState = "delegated"
	ApprovalTaskExpired   ApprovalTaskState = "expired"
	ApprovalTaskSkipped   ApprovalTaskState = "skipped"
)

// ApprovalStageMode is how the tasks within a single stage combine.
type ApprovalStageMode string

const (
	ApprovalStageAll    ApprovalStageMode = "all"    // 会签 — every approver must approve
	ApprovalStageAny    ApprovalStageMode = "any"    // 或签 — first approval wins
	ApprovalStageQuorum ApprovalStageMode = "quorum" // quorum — N out of M
)

// ApprovalRequest is the entity a user creates when they want permission to
// perform a high-risk action. The Payload column is the free-form JSON
// describing what exactly they want to do (command, sql, files, …).
type ApprovalRequest struct {
	ID            string                `gorm:"primaryKey;size:36" json:"id"` // UUID
	BusinessType  ApprovalBusinessType  `gorm:"size:32;index" json:"business_type"`
	Title         string                `gorm:"size:255" json:"title"`
	Reason        string                `gorm:"size:1024" json:"reason"`
	RequesterID   uint64                `gorm:"index" json:"requester_id"`
	RequesterName string                `gorm:"size:64" json:"requester_name"`
	// ResourceType / ResourceID address the resource being acted on. For
	// asset_access these point at a node; for credential_use a credential;
	// command_exec / sql_exec / file_transfer typically point at a session
	// or node.
	ResourceType  string                `gorm:"size:32;index" json:"resource_type,omitempty"`
	ResourceID    string                `gorm:"size:64;index" json:"resource_id,omitempty"`
	// Payload is the business-specific JSON (commands, sql, paths…).
	Payload       string                `gorm:"type:text" json:"payload,omitempty"`
	// TemplateID is the matched policy template; can be empty if a
	// catch-all template handled it.
	TemplateID    *uint64               `gorm:"index" json:"template_id,omitempty"`
	RiskLevel     ApprovalRiskLevel     `gorm:"size:16;index" json:"risk_level"`
	Status        ApprovalRequestStatus `gorm:"size:16;index" json:"status"`
	// Window the requester wants the Grant to cover; the issued Grant may
	// be tighter if the policy caps it.
	WindowStart   time.Time             `json:"window_start"`
	WindowEnd     time.Time             `json:"window_end"`
	// EffectiveWindowEnd is when the issued grant actually expires. May be
	// earlier than WindowEnd if the matched template caps duration.
	EffectiveWindowEnd *time.Time       `json:"effective_window_end,omitempty"`
	// CurrentStage points at which stage the workflow is on; -1 once the
	// request is in a terminal state.
	CurrentStage  int                   `gorm:"default:0" json:"current_stage"`
	TotalStages   int                   `json:"total_stages"`
	// Version is the optimistic-lock counter bumped on every transition.
	Version       uint64                `gorm:"default:0" json:"version"`
	CreatedAt     time.Time             `gorm:"index" json:"created_at"`
	UpdatedAt     time.Time             `json:"updated_at"`
	ResolvedAt    *time.Time            `json:"resolved_at,omitempty"`
	ClientIP      string                `gorm:"size:64" json:"client_ip,omitempty"`
}

func (ApprovalRequest) TableName() string { return "approval_requests" }

// ApprovalTask is one approval slot owned by one approver inside one stage of
// a Request. A stage with mode=all yields N tasks (one per approver) that
// must all approve. mode=any yields N tasks where the first decision closes
// the others. mode=quorum carries the QuorumN target on the parent Request's
// template snapshot.
type ApprovalTask struct {
	ID            uint64            `gorm:"primaryKey" json:"id"`
	RequestID     string            `gorm:"size:36;index:idx_task_request" json:"request_id"`
	Stage         int               `gorm:"index" json:"stage"`
	StageMode     ApprovalStageMode `gorm:"size:16" json:"stage_mode"`
	QuorumN       int               `json:"quorum_n,omitempty"`
	// ApproverID is the user assigned to this slot. ApproverRole is set when
	// the slot was resolved from a role; either both or just ApproverID
	// will be populated.
	ApproverID    uint64            `gorm:"index" json:"approver_id"`
	ApproverRole  string            `gorm:"size:64" json:"approver_role,omitempty"`
	State         ApprovalTaskState `gorm:"size:16;index" json:"state"`
	Comment       string            `gorm:"size:1024" json:"comment,omitempty"`
	// DelegatedTo is non-zero when the original approver delegated this
	// task to another user; the delegate's user_id is set here and a new
	// task row is inserted with that user as ApproverID.
	DelegatedTo   *uint64           `json:"delegated_to,omitempty"`
	ExpiresAt     *time.Time        `gorm:"index" json:"expires_at,omitempty"`
	DecidedAt     *time.Time        `json:"decided_at,omitempty"`
	CreatedAt     time.Time         `json:"created_at"`
}

func (ApprovalTask) TableName() string { return "approval_tasks" }

// ApprovalEventKind enumerates audit-ledger event types.
type ApprovalEventKind string

const (
	ApprovalEvRequestCreated   ApprovalEventKind = "request.created"
	ApprovalEvPolicyMatched    ApprovalEventKind = "policy.matched"
	ApprovalEvRiskComputed     ApprovalEventKind = "policy.risk_computed"
	ApprovalEvAutoApproved     ApprovalEventKind = "request.auto_approved"
	ApprovalEvTaskCreated      ApprovalEventKind = "task.created"
	ApprovalEvTaskApproved     ApprovalEventKind = "task.approved"
	ApprovalEvTaskRejected     ApprovalEventKind = "task.rejected"
	ApprovalEvTaskDelegated    ApprovalEventKind = "task.delegated"
	ApprovalEvTaskExpired      ApprovalEventKind = "task.expired"
	ApprovalEvTaskSkipped      ApprovalEventKind = "task.skipped"
	ApprovalEvStageAdvanced    ApprovalEventKind = "stage.advanced"
	ApprovalEvRequestApproved  ApprovalEventKind = "request.approved"
	ApprovalEvRequestRejected  ApprovalEventKind = "request.rejected"
	ApprovalEvRequestCancelled ApprovalEventKind = "request.cancelled"
	ApprovalEvRequestExpired   ApprovalEventKind = "request.expired"
	ApprovalEvGrantIssued      ApprovalEventKind = "grant.issued"
	ApprovalEvGrantVerified    ApprovalEventKind = "grant.verified"
	ApprovalEvGrantRevoked     ApprovalEventKind = "grant.revoked"
	ApprovalEvGrantExpired     ApprovalEventKind = "grant.expired"
	ApprovalEvNotifySent       ApprovalEventKind = "notify.sent"
	ApprovalEvNotifyFailed     ApprovalEventKind = "notify.failed"
)

// ApprovalEvent is the append-only audit ledger row. PrevHash + Hash form a
// SHA-256 chain so deleting / mutating one row breaks every subsequent row's
// hash. An optional Signature column carries a KMS detached signature over
// Hash so the chain itself can be proven authentic to a relying party who
// only trusts the KMS public key.
type ApprovalEvent struct {
	ID         uint64            `gorm:"primaryKey" json:"id"`
	RequestID  string            `gorm:"size:36;index" json:"request_id"`
	Kind       ApprovalEventKind `gorm:"size:48;index" json:"kind"`
	ActorID    uint64            `gorm:"index" json:"actor_id,omitempty"`
	ActorName  string            `gorm:"size:64" json:"actor_name,omitempty"`
	Payload    string            `gorm:"type:text" json:"payload,omitempty"`
	// PrevHash is the previous ApprovalEvent.Hash within the same RequestID
	// chain. Genesis events for a request hold a deterministic seed.
	PrevHash   []byte            `gorm:"type:bytea" json:"prev_hash"`
	Hash       []byte            `gorm:"type:bytea" json:"hash"`
	// Signature is an optional KMS-issued detached signature over Hash. The
	// KMSProviderID column points at the kms_providers row that signed it,
	// so a verifier can fetch the public key from there.
	Signature       []byte  `gorm:"type:bytea" json:"signature,omitempty"`
	KMSProviderID   *uint64 `json:"kms_provider_id,omitempty"`
	CreatedAt       time.Time `gorm:"index" json:"created_at"`
}

func (ApprovalEvent) TableName() string { return "approval_events" }

// ApprovalTemplateSelector matches an inbound Request against a template.
// Encoded as JSON: { business_type, resource_type?, attribute_predicates: {...} }.
// The Selector column is the JSON blob; loaded into approval.PolicyMatcher
// at runtime.
type ApprovalTemplate struct {
	ID            uint64    `gorm:"primaryKey" json:"id"`
	Name          string    `gorm:"size:128;uniqueIndex;not null" json:"name"`
	Description   string    `gorm:"size:255" json:"description"`
	BusinessType  ApprovalBusinessType `gorm:"size:32;index" json:"business_type"`
	Priority      int       `gorm:"default:100;index" json:"priority"` // lower wins
	Enabled       bool      `gorm:"default:true" json:"enabled"`
	IsSystem      bool      `gorm:"default:false" json:"is_system"`
	// Selector / Stages / RiskRule / AutoApprove are JSON blobs the policy
	// engine parses on use. See internal/approval/policy.go for the schema.
	Selector      string    `gorm:"type:text" json:"selector"`
	Stages        string    `gorm:"type:text" json:"stages"`
	RiskRule      string    `gorm:"type:text" json:"risk_rule,omitempty"`
	AutoApprove   string    `gorm:"type:text" json:"auto_approve,omitempty"`
	// MaxDurationSec caps the issued grant's effective window. 0 = use
	// requester window unchanged.
	MaxDurationSec int      `json:"max_duration_sec"`
	// DefaultTimeoutSec is per-task timeout before escalation kicks in. 0
	// disables timeout-based escalation.
	DefaultTimeoutSec int   `json:"default_timeout_sec"`
	CreatedAt     time.Time `json:"created_at"`
	UpdatedAt     time.Time `json:"updated_at"`
}

func (ApprovalTemplate) TableName() string { return "approval_templates" }

// ApprovalGrantStatus is the lifecycle state of an issued grant.
type ApprovalGrantStatus string

const (
	ApprovalGrantActive  ApprovalGrantStatus = "active"
	ApprovalGrantExpired ApprovalGrantStatus = "expired"
	ApprovalGrantRevoked ApprovalGrantStatus = "revoked"
	ApprovalGrantUsedUp  ApprovalGrantStatus = "used_up"
)

// ApprovalGrant is the time-bound permission slip issued when a Request is
// approved. The action-bearing modules (webssh / dbcli / sftp / desktop /
// portforward / secrets) check Grant.VerifyGrant before honouring the
// privileged action. This is what makes the approval enforceable rather than
// purely advisory.
//
// Granularity rules:
//   - asset_access      → ResourceType="node",       ResourceID=<node_id>
//   - credential_use    → ResourceType="credential", ResourceID=<credential_id>
//   - command_exec      → ResourceType="session",    ResourceID=<session_id>
//   - sql_exec          → ResourceType="session",    ResourceID=<session_id>
//   - file_transfer     → ResourceType="node",       ResourceID=<node_id>
//   - session_extend    → ResourceType="session",    ResourceID=<session_id>
//   - session_elevate   → ResourceType="session",    ResourceID=<session_id>
//   - audit_view        → ResourceType="session",    ResourceID=<session_id>
type ApprovalGrant struct {
	ID            string                `gorm:"primaryKey;size:36" json:"id"` // UUID
	RequestID     string                `gorm:"size:36;uniqueIndex" json:"request_id"`
	BusinessType  ApprovalBusinessType  `gorm:"size:32;index" json:"business_type"`
	BeneficiaryID uint64                `gorm:"index" json:"beneficiary_id"`
	ResourceType  string                `gorm:"size:32;index:idx_grant_resource" json:"resource_type"`
	ResourceID    string                `gorm:"size:64;index:idx_grant_resource" json:"resource_id"`
	// Actions is a comma-separated list of action codes mirroring the
	// AssetGrant convention (connect / sftp_read / sftp_write / exec / …).
	Actions       string                `gorm:"size:255" json:"actions"`
	// MaxUses caps how many times this grant can be redeemed. 0 = unlimited
	// within the window.
	MaxUses       int                   `gorm:"default:0" json:"max_uses"`
	UsedCount     int                   `gorm:"default:0" json:"used_count"`
	NotBefore     time.Time             `json:"not_before"`
	NotAfter      time.Time             `gorm:"index" json:"not_after"`
	Status        ApprovalGrantStatus   `gorm:"size:16;index" json:"status"`
	RevokedBy     *uint64               `json:"revoked_by,omitempty"`
	RevokedAt     *time.Time            `json:"revoked_at,omitempty"`
	RevokeReason  string                `gorm:"size:255" json:"revoke_reason,omitempty"`
	CreatedAt     time.Time             `json:"created_at"`
}

func (ApprovalGrant) TableName() string { return "approval_grants" }

// ApprovalSubscription stores which integration channels (webhook / IM /
// SIEM) should receive lifecycle notifications for which business types.
// Empty BusinessType means "all".
type ApprovalSubscription struct {
	ID           uint64               `gorm:"primaryKey" json:"id"`
	Name         string               `gorm:"size:128" json:"name"`
	Channel      string               `gorm:"size:32;index" json:"channel"` // webhook | email | feishu | dingtalk | wecom | slack | teams | siem
	Target       string               `gorm:"size:512" json:"target"`       // URL / address / bot token
	Secret       string               `gorm:"size:255" json:"secret,omitempty"`
	BusinessType ApprovalBusinessType `gorm:"size:32;index" json:"business_type,omitempty"`
	EventMask    string               `gorm:"size:255" json:"event_mask,omitempty"` // comma-separated ApprovalEventKind list
	Enabled      bool                 `gorm:"default:true" json:"enabled"`
	CreatedAt    time.Time            `json:"created_at"`
	UpdatedAt    time.Time            `json:"updated_at"`
}

func (ApprovalSubscription) TableName() string { return "approval_subscriptions" }
