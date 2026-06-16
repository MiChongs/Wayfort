// Package edition is the OPEN-SOURCE half of the edition/licensing system.
//
// It deliberately contains NO license verification, NO embedded key, NO signer,
// and NO claim parsing — publishing those would hand an attacker the gate logic
// and the key (the GitLab-EE crack). All it defines is:
//   - the entitlement data shape + feature constants (not secret),
//   - a Provider interface the enterprise build implements,
//   - a registration seam (RegisterFactory/Resolve), and
//   - the RequireFeature gin middleware.
//
// With no enterprise overlay compiled in, Resolve returns the Community provider,
// which grants nothing — so the open-source build runs as Community and every
// paid feature stays locked, with zero licensing internals on disk.
//
// The real Authority (Ed25519 verification, embedded public key, persistence)
// and the offline signer live in the SEPARATE PRIVATE enterprise module and
// register themselves via RegisterFactory in their init().
package edition

import (
	"context"
	"net/http"
	"time"

	"github.com/gin-gonic/gin"
	"go.uber.org/zap"
	"gorm.io/gorm"
)

// Edition tiers.
const (
	TierCommunity  = "community"
	TierEnterprise = "enterprise"
	TierFlagship   = "flagship"
)

// Feature keys — one per licensable subsystem. Stable strings, shared by the
// open core (route gates) and the enterprise overlay (tier bundles).
const (
	FeatureBreakGlass        = "break_glass"
	FeatureSecurityAnalytics = "security_analytics"
	FeatureReverseAgent      = "reverse_agent"
	FeatureAI                = "ai"
	FeatureDesktop           = "desktop"
	FeatureAdvancedKMS       = "advanced_kms"
	// Access-control X-Pack rule types (JumpServer v4 access-control parity).
	FeatureConnectionReview = "connection_review" // 资产连接复核
	FeatureDataMasking      = "data_masking"      // 数据脱敏
	FeatureConnectionMethod = "connection_method" // 连接方式控制
)

// Entitlement state.
const (
	StateCommunity = "community"
	StateActive    = "active"
	StateGrace     = "grace"
	StateExpired   = "expired"
	StateInvalid   = "invalid"
)

// Entitlements is the derived, read-only snapshot consumers read.
type Entitlements struct {
	Edition    string          `json:"edition"`
	State      string          `json:"state"`
	Licensed   bool            `json:"licensed"`
	Features   map[string]bool `json:"features"`
	Limits     map[string]int  `json:"limits,omitempty"`
	Customer   string          `json:"customer,omitempty"`
	LicenseID  string          `json:"license_id,omitempty"`
	IssuedAt   *time.Time      `json:"issued_at,omitempty"`
	NotBefore  *time.Time      `json:"not_before,omitempty"`
	ExpiresAt  *time.Time      `json:"expires_at,omitempty"`
	GraceUntil *time.Time      `json:"grace_until,omitempty"`
	Message    string          `json:"message,omitempty"`
}

// Has reports whether a feature is entitled.
func (e *Entitlements) Has(feature string) bool {
	return e != nil && e.Features != nil && e.Features[feature]
}

// Limit returns a numeric limit (0 = unlimited / unset).
func (e *Entitlements) Limit(key string) int {
	if e == nil || e.Limits == nil {
		return 0
	}
	return e.Limits[key]
}

// Provider is the entitlement authority. The Community default grants nothing;
// the enterprise overlay supplies the real, license-verifying implementation.
type Provider interface {
	Current() *Entitlements
	Has(feature string) bool
	Supported() bool // build can run a paid edition (has a verification key)
	Install(ctx context.Context, license string, actorID uint64) (*Entitlements, error)
	Remove(ctx context.Context, actorID uint64) (*Entitlements, error)
}

// Deps is what the enterprise factory needs to build the real provider.
type Deps struct {
	DB                *gorm.DB
	ConfigLicense     string
	ConfigLicenseFile string
	Logger            *zap.Logger
}

// factory is set by the enterprise overlay's init() via RegisterFactory.
var factory func(Deps) Provider

// RegisterFactory is called (once) by the enterprise overlay to plug in the real
// provider. The open-source build never calls it, so factory stays nil.
func RegisterFactory(f func(Deps) Provider) { factory = f }

// Resolve returns the enterprise provider when an overlay is compiled in, else
// the Community provider. Never nil.
func Resolve(d Deps) Provider {
	if factory != nil {
		if p := factory(d); p != nil {
			return p
		}
	}
	return Community{}
}

// Community is the open-source default: no license, nothing unlocked.
type Community struct{}

func communityEnt() *Entitlements {
	return &Entitlements{Edition: TierCommunity, State: StateCommunity, Features: map[string]bool{}}
}

func (Community) Current() *Entitlements { return communityEnt() }
func (Community) Has(string) bool        { return false }
func (Community) Supported() bool        { return false }
func (Community) Install(context.Context, string, uint64) (*Entitlements, error) {
	return nil, ErrUnsupported
}
func (Community) Remove(context.Context, uint64) (*Entitlements, error) { return communityEnt(), nil }

// ErrUnsupported is returned by the Community provider's Install — the OSS build
// has no verifier, so it cannot accept a license.
var ErrUnsupported = errCommunity("社区版不支持导入授权")

type errCommunity string

func (e errCommunity) Error() string { return string(e) }

// RequireFeature gates a route on an edition feature. INTENTIONALLY independent
// of RBAC — even a super-admin is blocked when the feature isn't licensed. A nil
// provider allows through (un-wired build). Returns 402.
func RequireFeature(feature string, p Provider) gin.HandlerFunc {
	return func(c *gin.Context) {
		if p == nil || p.Has(feature) {
			c.Next()
			return
		}
		ent := p.Current()
		c.AbortWithStatusJSON(http.StatusPaymentRequired, gin.H{
			"error":   "此功能需要更高版本授权",
			"feature": feature,
			"edition": ent.Edition,
			"state":   ent.State,
			"message": ent.Message,
		})
	}
}
