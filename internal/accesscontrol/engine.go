// Package accesscontrol is the unified rule engine behind the consolidated
// 「访问控制」module (JumpServer v4 parity). It evaluates ONE rule model
// (model.AccessRule) across five kinds — command_filter / user_login /
// asset_connection_review / data_masking / connection_method — with a single
// priority-ordered first-match contract over the dimensions 用户(user) × 资产
// (asset) × 账号(account=credential) plus IP and time-window conditions.
//
// It deliberately does NOT reimplement authorization or the approval workflow:
//   - the USER dimension is resolved via asset.Resolver.GranteesForUser (reusing
//     the same group/department ancestor expansion authorization uses),
//   - the `review` action is fulfilled by the existing approval engine at the
//     call site (P2),
//   - the three X-Pack kinds are gated through pkg/edition and fail OPEN (no-op
//     accept) when unlicensed, so a downgrade never locks Community users out.
package accesscontrol

import (
	"context"
	"time"

	"github.com/michongs/wayfort/internal/model"
	"github.com/michongs/wayfort/pkg/edition"
	"go.uber.org/zap"
)

// RuleSource yields the active rules for a kind, already ordered by priority ASC.
// Satisfied by *repo.AccessRuleRepo.
type RuleSource interface {
	ListActiveByKind(ctx context.Context, kind model.AccessRuleKind) ([]model.AccessRule, error)
}

// GranteeResolver resolves a user's expanded grantee set (user/group/dept/role).
// Satisfied by *asset.Resolver.
type GranteeResolver interface {
	GranteesForUser(ctx context.Context, userID uint64) (map[model.GranteeType][]uint64, error)
}

// FeatureChecker reports edition entitlements. Satisfied by edition.Provider.
type FeatureChecker interface {
	Has(feature string) bool
}

// Input carries the facts a rule is matched against. Fields not relevant to a
// kind may be zero (e.g. Command only for command_filter).
type Input struct {
	UserID       uint64
	NodeID       uint64
	NodeGroupIDs []uint64 // groups the node belongs to (optional)
	NodeTagIDs   []uint64 // tags the node carries (optional)
	CredentialID uint64   // the account dimension
	ClientIP     string
	Now          time.Time // zero → time.Now()
	Protocol     string    // connection_method
	Command      string    // command_filter (matched by the caller against Spec)

	// Grantees, when provided, skips the GranteeResolver lookup (caller already
	// has it). Otherwise the engine resolves lazily only when a rule needs it.
	Grantees map[model.GranteeType][]uint64
}

// Decision is the outcome of Evaluate. When Matched is false, Action is Accept
// (no rule applied) and Rule is nil.
type Decision struct {
	Matched bool
	Action  model.AccessRuleAction
	Rule    *model.AccessRule
}

// Engine evaluates access rules. edition may be nil (no gating — every kind runs).
type Engine struct {
	rules    RuleSource
	grantees GranteeResolver
	edition  FeatureChecker
	logger   *zap.Logger
}

func NewEngine(rules RuleSource, grantees GranteeResolver, ed FeatureChecker, logger *zap.Logger) *Engine {
	if logger == nil {
		logger = zap.NewNop()
	}
	return &Engine{rules: rules, grantees: grantees, edition: ed, logger: logger}
}

// kindFeature maps an X-Pack kind to its required edition feature, or "" for the
// always-on Community kinds.
func kindFeature(kind model.AccessRuleKind) string {
	switch kind {
	case model.RuleAssetConnectionReview:
		return edition.FeatureConnectionReview
	case model.RuleDataMasking:
		return edition.FeatureDataMasking
	case model.RuleConnectionMethod:
		return edition.FeatureConnectionMethod
	default:
		return "" // command_filter, user_login → Community
	}
}

// Gated reports whether a kind's enforcement is currently suppressed by edition
// (unlicensed X-Pack kind). Callers can short-circuit expensive context-building.
func (e *Engine) Gated(kind model.AccessRuleKind) bool {
	feat := kindFeature(kind)
	return feat != "" && e.edition != nil && !e.edition.Has(feat)
}

// Evaluate returns the first matching active rule of kind, in priority order.
// X-Pack kinds whose feature is not licensed return a no-op Accept (fail OPEN).
func (e *Engine) Evaluate(ctx context.Context, kind model.AccessRuleKind, in Input) (Decision, error) {
	accept := Decision{Matched: false, Action: model.ActionAccept}
	if e.Gated(kind) {
		return accept, nil
	}
	rules, err := e.rules.ListActiveByKind(ctx, kind)
	if err != nil {
		return accept, err
	}
	now := in.Now
	if now.IsZero() {
		now = time.Now()
	}
	grantees := in.Grantees

	for i := range rules {
		r := &rules[i]
		if !withinValidity(r, now) {
			continue
		}
		users := parseSelector(r.Users)
		if !users.All && grantees == nil && in.UserID != 0 && e.grantees != nil {
			if g, gerr := e.grantees.GranteesForUser(ctx, in.UserID); gerr == nil {
				grantees = g
			} else {
				e.logger.Warn("accesscontrol: grantee resolve failed", zap.Uint64("user", in.UserID), zap.Error(gerr))
			}
		}
		if !matchUser(users, grantees, in.UserID) {
			continue
		}
		if !matchAsset(parseSelector(r.Assets), in.NodeID, in.NodeGroupIDs, in.NodeTagIDs) {
			continue
		}
		if !matchAccount(parseSelector(r.Accounts), in.CredentialID) {
			continue
		}
		if !matchIP(r.IPRule, in.ClientIP) {
			continue
		}
		if !matchTime(r.TimeWindow, now) {
			continue
		}
		// command_filter rules additionally require the command to match the
		// rule's command groups (Spec); a rule with no command groups matches
		// every command.
		if kind == model.RuleCommandFilter && !commandMatches(r.Spec, in.Command) {
			continue
		}
		// connection_method rules apply only when the requested protocol is in the
		// rule's method set (empty set = all methods).
		if kind == model.RuleConnectionMethod && !methodMatches(r.Spec, in.Protocol) {
			continue
		}
		return Decision{Matched: true, Action: r.Action, Rule: r}, nil
	}
	return accept, nil
}

func withinValidity(r *model.AccessRule, now time.Time) bool {
	if r.ValidFrom != nil && now.Before(*r.ValidFrom) {
		return false
	}
	if r.ValidTo != nil && now.After(*r.ValidTo) {
		return false
	}
	return true
}
