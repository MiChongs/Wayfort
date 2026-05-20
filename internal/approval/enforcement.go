package approval

import (
	"context"
	"errors"
	"fmt"
	"strconv"
	"sync"
	"time"

	"github.com/michongs/jumpserver-anonymous/internal/model"
	"github.com/michongs/jumpserver-anonymous/internal/repo"
	"gorm.io/gorm"
)

// Enforcer answers a single question per action-bearing module: "is this
// (business_type, resource) gated on an approval grant?" The default
// implementation reads the per-resource RequiresApproval flags off
// model.Node and model.Credential. A future implementation could fold in
// policy-driven enforcement (e.g. "every action on a prod-tagged node
// requires approval, regardless of the flag") without touching the
// subsystems that call into it.
type Enforcer interface {
	IsEnforced(ctx context.Context, bt model.ApprovalBusinessType,
		resourceType, resourceID string) (bool, error)
}

// EnforcementCheck is what a subsystem hands the service when it wants both
// the "is it required" question and the "do I have a grant" question
// answered together. Used by every action-bearing module so the
// "check before action" idiom is identical across them.
type EnforcementCheck struct {
	UserID       uint64
	BusinessType model.ApprovalBusinessType
	ResourceType string
	ResourceID   string
	// Action is the specific verb the caller wants performed. Should
	// match one of the action codes embedded in ApprovalGrant.Actions
	// (e.g. "connect", "sftp_write", "credential_use"). Pass "" to
	// match any action covered by the grant.
	Action string
}

// EnforcementResult is what the service returns. Allowed=true is the only
// "proceed" state; the caller must deny on Allowed=false.
type EnforcementResult struct {
	// Required reports whether approval was required at all. False
	// means the resource does NOT have the relevant RequiresApproval
	// flag set and the action proceeds unconditionally.
	Required bool
	// Allowed reports the final yes/no on the action. Either Required
	// is false (no gate), or Required is true AND VerifyGrant found
	// an active matching grant.
	Allowed bool
	// GrantID + ExpiresAt are set when Allowed=true and Required=true,
	// so callers can echo "session valid until X" or pass the grant
	// ID into a use-count incrementer.
	GrantID   string
	ExpiresAt time.Time
	// Reason carries an admin-facing string explaining why an action
	// was denied; safe to surface to the requester verbatim.
	Reason string
}

// CheckEnforced is the unified front-door subsystems call. It answers both
// questions ("required?" and "do I have a grant?") in one shot. The caller
// denies the action when Allowed=false and otherwise proceeds.
//
// The semantics for the Required gate:
//
//   - asset_access / command_exec / session_extend / session_elevate /
//     vendor_access → Node.RequiresApprovalForConnect
//   - file_transfer → Node.RequiresApprovalForFileXfer
//   - credential_use → Credential.RequiresApprovalForUse
//   - sql_exec / break_glass / audit_view → currently unconditionally
//     unrequired (the action lives elsewhere; admins can still create
//     requests + grants, they just aren't auto-enforced by this helper)
//
// Subsequent phases will let admins toggle policy-driven enforcement
// (e.g. "every prod-tagged node requires approval for ssh_exec") via the
// template selector; the Enforcer interface is the seam for that.
func (s *Service) CheckEnforced(ctx context.Context, chk EnforcementCheck) (EnforcementResult, error) {
	enf := s.enforcer
	if enf == nil {
		// No enforcer wired → nothing is gated. Behaviour matches the
		// pre-Phase-16 codebase.
		return EnforcementResult{Required: false, Allowed: true}, nil
	}
	required, err := enf.IsEnforced(ctx, chk.BusinessType, chk.ResourceType, chk.ResourceID)
	if err != nil {
		// Fail closed: an unreachable repo / DB hiccup must not silently
		// open the gate. The caller still gets Allowed=false with a
		// reason so the audit trail captures the denial.
		return EnforcementResult{Required: true, Allowed: false,
			Reason: "approval gate lookup failed: " + err.Error()}, err
	}
	if !required {
		return EnforcementResult{Required: false, Allowed: true}, nil
	}
	res, err := s.VerifyGrant(ctx, GrantCheck{
		UserID:       chk.UserID,
		BusinessType: chk.BusinessType,
		ResourceType: chk.ResourceType,
		ResourceID:   chk.ResourceID,
		Action:       chk.Action,
	})
	if err != nil {
		return EnforcementResult{Required: true, Allowed: false,
			Reason: "approval verify failed: " + err.Error()}, err
	}
	if !res.Permitted {
		return EnforcementResult{Required: true, Allowed: false,
			Reason: "approval required: no active grant for " + string(chk.BusinessType) +
				" on " + chk.ResourceType + ":" + chk.ResourceID}, nil
	}
	return EnforcementResult{
		Required:  true,
		Allowed:   true,
		GrantID:   res.GrantID,
		ExpiresAt: res.ExpiresAt,
	}, nil
}

// ErrApprovalRequired is the sentinel non-action-bearing modules can return
// upward. The webssh / sftp / dbcli / desktop handlers convert it to an
// HTTP 403 with a body containing the EnforcementResult.Reason so a UI can
// route the user into the "create an approval request" flow.
var ErrApprovalRequired = errors.New("approval required: no active grant for this action")

// EnforcementError wraps ErrApprovalRequired with the EnforcementResult so
// handlers can surface the reason / grant_id when applicable.
type EnforcementError struct {
	Result EnforcementResult
}

func (e *EnforcementError) Error() string {
	if e.Result.Reason != "" {
		return e.Result.Reason
	}
	return ErrApprovalRequired.Error()
}

// Is supports errors.Is(err, ErrApprovalRequired) at every call site.
func (e *EnforcementError) Is(target error) bool { return target == ErrApprovalRequired }

// ----- default Enforcer implementation -----

// repoEnforcer is the default Enforcer the bootstrap wires. It reads the
// per-resource flags directly off the DB; results are cached briefly so a
// hot path (every SFTP write, every SSH dial) doesn't repeatedly hit the
// nodes / credentials tables.
type repoEnforcer struct {
	db    *gorm.DB
	nodes *repo.NodeRepo
	creds *repo.CredentialRepo

	cache   sync.Map // map[cacheKey]cachedFlag
	cacheTTL time.Duration
}

type cacheKey struct {
	rt, rid string
}
type cachedFlag struct {
	connect    bool
	fileXfer   bool
	credUse    bool
	expiresAt  time.Time
}

// NewRepoEnforcer is the default constructor. Pass non-nil repos; the
// enforcer falls back to "not enforced" for any nil repo so partial wiring
// degrades to a no-op rather than blocking traffic on a misconfigured boot.
func NewRepoEnforcer(db *gorm.DB, nodes *repo.NodeRepo, creds *repo.CredentialRepo) Enforcer {
	return &repoEnforcer{
		db:       db,
		nodes:    nodes,
		creds:    creds,
		cacheTTL: 5 * time.Second,
	}
}

func (e *repoEnforcer) IsEnforced(ctx context.Context, bt model.ApprovalBusinessType,
	resourceType, resourceID string) (bool, error) {
	if resourceID == "" {
		return false, nil
	}
	switch resourceType {
	case "node":
		return e.nodeFlag(ctx, resourceID, bt)
	case "credential":
		return e.credentialFlag(ctx, resourceID, bt)
	}
	// Other resource types are not auto-enforced by this helper yet.
	// Admins can still create approval requests against them, but the
	// 6 action-bearing modules don't gate on them.
	return false, nil
}

func (e *repoEnforcer) nodeFlag(ctx context.Context, idStr string,
	bt model.ApprovalBusinessType) (bool, error) {
	cf, ok := e.lookupCached("node", idStr)
	if !ok {
		if e.nodes == nil {
			return false, nil
		}
		id, err := strconv.ParseUint(idStr, 10, 64)
		if err != nil || id == 0 {
			return false, nil
		}
		n, err := e.nodes.FindByID(ctx, id)
		if err != nil {
			return false, fmt.Errorf("enforcer: load node %d: %w", id, err)
		}
		if n == nil {
			return false, nil
		}
		cf = cachedFlag{
			connect:   n.RequiresApprovalForConnect,
			fileXfer:  n.RequiresApprovalForFileXfer,
			expiresAt: time.Now().Add(e.cacheTTL),
		}
		e.cache.Store(cacheKey{"node", idStr}, cf)
	}
	switch bt {
	case model.ApprovalBizFileTransfer:
		return cf.fileXfer, nil
	case model.ApprovalBizAssetAccess, model.ApprovalBizCommandExec,
		model.ApprovalBizSessionExtend, model.ApprovalBizSessionElevate,
		model.ApprovalBizVendorAccess:
		return cf.connect, nil
	}
	return false, nil
}

func (e *repoEnforcer) credentialFlag(ctx context.Context, idStr string,
	bt model.ApprovalBusinessType) (bool, error) {
	if bt != model.ApprovalBizCredentialUse {
		return false, nil
	}
	cf, ok := e.lookupCached("credential", idStr)
	if !ok {
		if e.creds == nil {
			return false, nil
		}
		id, err := strconv.ParseUint(idStr, 10, 64)
		if err != nil || id == 0 {
			return false, nil
		}
		var cred model.Credential
		if err := e.db.WithContext(ctx).Select("id", "requires_approval_for_use").
			First(&cred, id).Error; err != nil {
			if errors.Is(err, gorm.ErrRecordNotFound) {
				return false, nil
			}
			return false, fmt.Errorf("enforcer: load credential %d: %w", id, err)
		}
		cf = cachedFlag{
			credUse:   cred.RequiresApprovalForUse,
			expiresAt: time.Now().Add(e.cacheTTL),
		}
		e.cache.Store(cacheKey{"credential", idStr}, cf)
	}
	return cf.credUse, nil
}

func (e *repoEnforcer) lookupCached(rt, rid string) (cachedFlag, bool) {
	v, ok := e.cache.Load(cacheKey{rt, rid})
	if !ok {
		return cachedFlag{}, false
	}
	cf := v.(cachedFlag)
	if time.Now().After(cf.expiresAt) {
		e.cache.Delete(cacheKey{rt, rid})
		return cachedFlag{}, false
	}
	return cf, true
}
