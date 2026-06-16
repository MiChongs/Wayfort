package model

import "time"

// Break-glass (应急访问) — an emergency-access governance layer built on top of
// the approval engine (security-architecture.md "失败安全" + least-privilege).
//
// A BreakGlassActivation is one emergency event: an operator needs privileged
// access to an asset RIGHT NOW, faster than the standard grant path allows,
// under heavy compensating controls — mandatory justification + incident ref,
// a hard time-box, immediate fan-out to the security team, forced recording +
// live-watch, mandatory post-use review, and an admin kill-switch.
//
// Break-glass does NOT invent a second grant lifecycle. The actual access is
// granted by reusing the existing machinery:
//   - a time-boxed AssetGrant (Source="break_glass") so every asset-resolver
//     gate (desktop / db / sftp / files / …) sees the access and the workspace
//     lists the node, and
//   - a break_glass ApprovalGrant so every approval enforcement point
//     (webssh / telnet / RDP / dbcli / tcpfwd / …) honours it on
//     approval-flagged nodes and the renewal-aware WatchGrant cutoff applies.
//
// The activation row is the governance object that links both and tracks the
// lifecycle. It is append-mostly: once closed it is immutable.

// BreakGlassScopeType narrows which assets a policy governs.
type BreakGlassScopeType string

const (
	BreakGlassScopeAll  BreakGlassScopeType = "all"  // every asset
	BreakGlassScopeTag  BreakGlassScopeType = "tag"  // assets carrying ScopeID tag
	BreakGlassScopeNode BreakGlassScopeType = "node" // the single node ScopeID
)

// BreakGlassPolicy is the governance configuration for emergency access. The
// *who-may-approve* policy stays the approval template (builtin.break_glass);
// this row adds the emergency-specific facets an approval template can't model.
type BreakGlassPolicy struct {
	ID          uint64              `gorm:"primaryKey" json:"id"`
	Name        string              `gorm:"size:128;uniqueIndex;not null" json:"name"`
	Description string              `gorm:"size:512" json:"description,omitempty"`
	Enabled     bool                `gorm:"default:true" json:"enabled"`
	ScopeType   BreakGlassScopeType `gorm:"size:16;default:all" json:"scope_type"`
	ScopeID     *uint64             `json:"scope_id,omitempty"`
	// MaxDurationSec hard-caps the access window. The effective window is the
	// minimum of this, the global break_glass.max_duration setting, and the
	// approval template cap — defense in depth.
	MaxDurationSec int `gorm:"default:1800" json:"max_duration_sec"`
	// RequireIncidentRef forces the requester to supply a ticket / incident id.
	RequireIncidentRef bool `gorm:"default:true" json:"require_incident_ref"`
	// RequireDualAuth forces a second human to approve even when fail-open is
	// allowed (no truly-unilateral activation): the request routes through one
	// expedited approver before access is granted.
	RequireDualAuth bool `gorm:"default:false" json:"require_dual_auth"`
	// AllowFailOpen permits self-service activation with no prior approval — the
	// classic "break the glass". Immediate access, fully audited, security
	// notified, post-use review forced on. Per-policy opt-in, AND-ed with the
	// global break_glass.allow_fail_open kill-switch.
	AllowFailOpen bool `gorm:"default:false" json:"allow_fail_open"`
	// RequirePostUseReview blocks the activation from reaching "closed" until a
	// reviewer (never the requester) signs off. Always forced true for fail-open.
	RequirePostUseReview bool   `gorm:"default:true" json:"require_post_use_review"`
	CreatedBy            uint64 `json:"created_by,omitempty"`
	CreatedAt            time.Time `json:"created_at"`
	UpdatedAt            time.Time `json:"updated_at"`
}

func (BreakGlassPolicy) TableName() string { return "break_glass_policies" }

// BreakGlassMode is how an activation obtained its access.
type BreakGlassMode string

const (
	// BreakGlassModePreApproved rode the approval flow (one or more approvers
	// decided) before access was granted.
	BreakGlassModePreApproved BreakGlassMode = "pre_approved"
	// BreakGlassModeFailOpen self-activated immediately with no prior approval.
	// Only reachable when policy + global both allow it and dual-auth is off.
	BreakGlassModeFailOpen BreakGlassMode = "fail_open"
)

// BreakGlassStatus is the lifecycle state of one activation.
type BreakGlassStatus string

const (
	BreakGlassPending     BreakGlassStatus = "pending"      // awaiting approval (pre_approved)
	BreakGlassActive      BreakGlassStatus = "active"       // access granted, window open
	BreakGlassExpired     BreakGlassStatus = "expired"      // window lapsed naturally
	BreakGlassRevoked     BreakGlassStatus = "revoked"      // admin kill-switch
	BreakGlassRejected    BreakGlassStatus = "rejected"     // approver denied (pre_approved)
	BreakGlassUnderReview BreakGlassStatus = "under_review" // ended, awaiting post-use review
	BreakGlassClosed      BreakGlassStatus = "closed"       // reviewed / no review needed — terminal
)

// BreakGlassReviewVerdict is a reviewer's post-use judgement.
type BreakGlassReviewVerdict string

const (
	BreakGlassVerdictJustified    BreakGlassReviewVerdict = "justified"
	BreakGlassVerdictUnjustified  BreakGlassReviewVerdict = "unjustified"
	BreakGlassVerdictInconclusive BreakGlassReviewVerdict = "inconclusive"
)

// BreakGlassActivation is one emergency-access event.
type BreakGlassActivation struct {
	ID            string  `gorm:"primaryKey;size:36" json:"id"` // UUID
	PolicyID      *uint64 `gorm:"index" json:"policy_id,omitempty"`
	PolicyName    string  `gorm:"size:128" json:"policy_name,omitempty"`
	RequesterID   uint64  `gorm:"index" json:"requester_id"`
	RequesterName string  `gorm:"size:64" json:"requester_name"`
	// ResourceType is "node"; ResourceID is the numeric node id as a string
	// (mirrors the approval grant addressing convention).
	ResourceType  string `gorm:"size:32" json:"resource_type"`
	ResourceID    string `gorm:"size:64;index" json:"resource_id"`
	ResourceName  string `gorm:"size:128" json:"resource_name,omitempty"`
	Justification string `gorm:"type:text" json:"justification"`
	IncidentRef   string `gorm:"size:128" json:"incident_ref,omitempty"`

	Mode   BreakGlassMode   `gorm:"size:16;index" json:"mode"`
	Status BreakGlassStatus `gorm:"size:16;index" json:"status"`

	// Linkage into the reused approval + asset machinery. The approval IDs are
	// stored as plain strings (no FK constraint) so an archived/rotated approval
	// row never blocks reading the governance timeline.
	ApprovalRequestID string  `gorm:"size:36;index" json:"approval_request_id,omitempty"`
	ApprovalGrantID   string  `gorm:"size:36" json:"approval_grant_id,omitempty"`
	AssetGrantID      *uint64 `json:"asset_grant_id,omitempty"`

	ActivatedAt *time.Time `json:"activated_at,omitempty"`
	NotAfter    *time.Time `gorm:"index" json:"not_after,omitempty"`

	// Kill switch.
	RevokedBy     *uint64    `json:"revoked_by,omitempty"`
	RevokedByName string     `gorm:"size:64" json:"revoked_by_name,omitempty"`
	RevokedAt     *time.Time `json:"revoked_at,omitempty"`
	RevokeReason  string     `gorm:"size:255" json:"revoke_reason,omitempty"`

	// Post-use review.
	ReviewRequired bool                    `gorm:"default:true" json:"review_required"`
	ReviewerID     *uint64                 `json:"reviewer_id,omitempty"`
	ReviewerName   string                  `gorm:"size:64" json:"reviewer_name,omitempty"`
	ReviewedAt     *time.Time              `json:"reviewed_at,omitempty"`
	ReviewVerdict  BreakGlassReviewVerdict `gorm:"size:16" json:"review_verdict,omitempty"`
	ReviewComment  string                  `gorm:"type:text" json:"review_comment,omitempty"`

	ClientIP  string    `gorm:"size:64" json:"client_ip,omitempty"`
	CreatedAt time.Time `gorm:"index" json:"created_at"`
	UpdatedAt time.Time `json:"updated_at"`
}

func (BreakGlassActivation) TableName() string { return "break_glass_activations" }

// IsTerminal reports whether the activation has reached an immutable end state.
func (a BreakGlassActivation) IsTerminal() bool {
	switch a.Status {
	case BreakGlassClosed, BreakGlassRejected:
		return true
	}
	return false
}
