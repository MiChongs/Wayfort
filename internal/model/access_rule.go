package model

import "time"

// AccessRuleKind discriminates the five access-control rule families, mirroring
// JumpServer v4「访问控制」. One unified table; the kind decides where in the live
// flow the rule is evaluated (login / connect / command / query / connect-method).
type AccessRuleKind string

const (
	RuleCommandFilter         AccessRuleKind = "command_filter"          // Community
	RuleUserLogin             AccessRuleKind = "user_login"              // Community
	RuleAssetConnectionReview AccessRuleKind = "asset_connection_review" // X-Pack
	RuleDataMasking           AccessRuleKind = "data_masking"            // X-Pack
	RuleConnectionMethod      AccessRuleKind = "connection_method"       // X-Pack
)

// AccessRuleAction is the outcome when a rule matches. Common set across kinds;
// some kinds carry extra behaviour in Spec (e.g. command_filter block, data
// masking columns).
type AccessRuleAction string

const (
	ActionAccept AccessRuleAction = "accept" // allow, no further rules
	ActionDeny   AccessRuleAction = "deny"   // block the action
	ActionReview AccessRuleAction = "review" // route through the approval workflow
	ActionNotify AccessRuleAction = "notify" // non-blocking: pass + notify
	ActionAlert  AccessRuleAction = "alert"  // non-blocking: pass + raise a security alert
)

// AccessRule is one unified rule across all five access-control kinds. The three
// dimension columns (Users / Assets / Accounts) and the two condition columns
// (IPRule / TimeWindow) are JSON/string blobs the engine parses on use — same
// "string column + parse at runtime" convention as ApprovalTemplate. Account
// dimension maps to Credential (this product models login identities as
// credentials, not per-asset system users).
type AccessRule struct {
	ID          uint64         `gorm:"primaryKey" json:"id"`
	Kind        AccessRuleKind `gorm:"size:32;not null;index:idx_access_rule_kind" json:"kind"`
	Name        string         `gorm:"size:128;not null" json:"name"`
	Description string         `gorm:"size:255" json:"description,omitempty"`
	// Priority 1..100, lower wins (same ASC first-match contract as approval
	// templates). Default 50, matching v4.
	Priority int  `gorm:"default:50;index" json:"priority"`
	Active   bool `gorm:"default:true;index:idx_access_rule_kind" json:"active"`
	IsSystem bool `gorm:"default:false" json:"is_system"`

	// Dimension selectors — JSON-encoded accessSelector
	// ({all, user_ids, group_ids, dept_ids, role_ids, node_ids, asset_group_ids,
	// tag_ids, credential_ids}). Empty string = "all" (match anything) for that
	// dimension.
	Users    string `gorm:"type:text" json:"users,omitempty"`    // subject: user/group/dept/role
	Assets   string `gorm:"type:text" json:"assets,omitempty"`   // asset: node/asset_group/tag
	Accounts string `gorm:"type:text" json:"accounts,omitempty"` // account = credential

	// Conditions
	IPRule     string `gorm:"size:512" json:"ip_rule,omitempty"`      // comma-sep CIDR / range; "" or "*" = any
	TimeWindow string `gorm:"type:text" json:"time_window,omitempty"` // JSON {weekdays,start,end} or ""

	Action AccessRuleAction `gorm:"size:24;not null" json:"action"`
	// Spec is kind-specific config (JSON):
	//   command_filter         → {command_groups:[{type:"regex|command",content,ignore_case}]}
	//   data_masking           → {columns:[...], method:"partial|hash|fixed"}
	//   connection_method      → {methods:["ssh","rdp",...], mode:"allow|forbid"}
	//   asset_connection_review→ {template_id?:N}  (reviewer routing reuses approval)
	//   user_login             → {require_mfa?:bool}
	Spec string `gorm:"type:text" json:"spec,omitempty"`

	// Validity period of the RULE itself (distinct from a granted access window).
	ValidFrom *time.Time `json:"valid_from,omitempty"`
	ValidTo   *time.Time `json:"valid_to,omitempty"`

	CreatedBy uint64    `json:"created_by,omitempty"`
	CreatedAt time.Time `json:"created_at"`
	UpdatedAt time.Time `json:"updated_at"`
}

func (AccessRule) TableName() string { return "access_rules" }
