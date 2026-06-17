package api

import (
	"bytes"
	"context"
	"encoding/json"
	"io"
	"net/http"
	"strconv"
	"time"

	"github.com/gin-gonic/gin"
	"github.com/michongs/wayfort/internal/accesscontrol"
	"github.com/michongs/wayfort/internal/anomaly"
	"github.com/michongs/wayfort/internal/audit"
	"github.com/michongs/wayfort/internal/auth"
	"github.com/michongs/wayfort/internal/config"
	"github.com/michongs/wayfort/internal/geoip"
	"github.com/michongs/wayfort/internal/mfa"
	"github.com/michongs/wayfort/internal/model"
	"github.com/michongs/wayfort/internal/notify"
	"github.com/michongs/wayfort/internal/passkey"
	"github.com/michongs/wayfort/internal/repo"
)

// AuthHandler glues together the password / MFA / Passkey / OIDC login flows
// and emits login history rows for audit + anomaly detection.
type AuthHandler struct {
	Registry  *auth.Registry
	Issuer    *auth.Issuer
	Users     *repo.UserRepo
	MFA       *repo.UserMFARepo
	History   *repo.LoginHistoryRepo
	Lockout   *auth.LockoutPolicy
	Blocklist *auth.Blocklist
	TOTP      *mfa.TOTPService
	Email     *mfa.EmailOTPService
	Recovery  *mfa.RecoveryService
	Passkey   *passkey.Service
	OIDC      *auth.OIDCManager
	Anomaly   *anomaly.Detector
	Mailer    *notify.Mailer
	// Writer mirrors login outcomes into the global audit trail so the audit
	// center's 认证 lane is populated. May be nil (events are then skipped).
	Writer  *audit.Writer
	AnonEna bool
	// AnonSpec carries the sandbox resource caps so the public sandbox page can
	// render an honest spec (TTL countdown, limits) without a second endpoint.
	AnonSpec config.AnonymousConfig
	OIDCRepo *repo.OIDCClientRepo
	// LoginRules is the consolidated access-control rule engine evaluated on each
	// password login (kind=user_login): deny / require-MFA / notify / alert by
	// user × IP × time. Nil → no login rules (Community default = zero impact).
	LoginRules *accesscontrol.Engine
}

// ----- Step 1: password -----

func (h *AuthHandler) Login(c *gin.Context) {
	provider := c.DefaultQuery("provider", "local")
	p, ok := h.Registry.Get(provider)
	if !ok {
		c.JSON(http.StatusBadRequest, gin.H{"error": "unknown provider"})
		return
	}
	var payload auth.LoginPayload
	if err := c.ShouldBindJSON(&payload); err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"error": err.Error()})
		return
	}
	if err := h.Lockout.Check(c.Request.Context(), payload.Username); err != nil {
		h.recordHistory(c, nil, payload.Username, model.LoginLocked, model.AuthMethodPassword, model.MFAMethodNone, "account locked")
		c.JSON(http.StatusLocked, gin.H{"error": err.Error()})
		return
	}
	user, err := p.Login(c.Request.Context(), payload)
	if err != nil {
		count, locked, _ := h.Lockout.RecordFailure(c.Request.Context(), payload.Username)
		if locked {
			// Notify the locked-out account: the dispatcher delivers both an in-app
			// notification and an email; without it, fall back to a plain email.
			if u, _ := h.Users.FindByUsername(c.Request.Context(), payload.Username); u != nil {
				mins := int(h.Lockout.Duration.Minutes())
				if h.Anomaly != nil {
					go h.Anomaly.NotifyLocked(u, mins)
				} else if u.Email != "" && h.Mailer != nil {
					h.Mailer.Send(notify.AccountLockedMessage(u.Email, u.Username, mins))
				}
			}
		}
		_ = count
		h.recordHistory(c, nil, payload.Username, model.LoginFailed, model.AuthMethodPassword, model.MFAMethodNone, err.Error())
		c.JSON(http.StatusUnauthorized, gin.H{"error": err.Error()})
		return
	}
	if user.PasskeyOnly {
		c.JSON(http.StatusForbidden, gin.H{"error": "this account requires Passkey login"})
		return
	}
	h.Lockout.ClearFailures(c.Request.Context(), user.Username)

	// P3 — access-control user-login rules (kind=user_login, Community). Match by
	// user × source IP × time window → deny / require-MFA / review / notify. No
	// rules configured ⇒ zero impact (Community default).
	forceMFA := false
	if h.LoginRules != nil {
		dec, _ := h.LoginRules.Evaluate(c.Request.Context(), model.RuleUserLogin, accesscontrol.Input{
			UserID:   user.ID,
			ClientIP: c.ClientIP(),
		})
		if dec.Matched {
			switch dec.Action {
			case model.ActionDeny:
				h.recordHistory(c, &user.ID, user.Username, model.LoginFailed, model.AuthMethodPassword, model.MFAMethodNone, "登录被访问控制规则拒绝")
				c.JSON(http.StatusForbidden, gin.H{"error": "登录被访问控制规则拒绝"})
				return
			case model.ActionReview:
				// Synchronous login can't wait on an async work order; surface a
				// clear "needs approval" block. (Full async login-approval is a
				// follow-up that needs a pending-login UX.)
				h.recordHistory(c, &user.ID, user.Username, model.LoginFailed, model.AuthMethodPassword, model.MFAMethodNone, "登录需管理员审批")
				c.JSON(http.StatusForbidden, gin.H{"error": "登录需管理员审批，请联系管理员"})
				return
			}
			// require_mfa modifier (applies when the login is allowed): force the
			// MFA step even if the user hasn't enrolled a factor.
			if loginRuleRequiresMFA(dec.Rule) {
				forceMFA = true
			}
		}
	}

	// MFA?
	methods, err := h.availableMFA(c.Request.Context(), user)
	if err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": err.Error()})
		return
	}
	if len(methods) == 0 && forceMFA {
		// Rule forced step-up but nothing enrolled → push the email-OTP path
		// (mirrors the MFAEnforced fallback in availableMFA).
		methods = []string{"email"}
	}
	if len(methods) > 0 {
		token, exp, err := h.Issuer.IssueChallenge(user.ID, user.Username, methods, 5*time.Minute)
		if err != nil {
			c.JSON(http.StatusInternalServerError, gin.H{"error": err.Error()})
			return
		}
		h.recordHistory(c, &user.ID, user.Username, model.LoginMFARequired, model.AuthMethodPassword, model.MFAMethodNone, "")
		c.JSON(http.StatusOK, gin.H{
			"step":            "mfa_required",
			"challenge_token": token,
			"expires_at":      exp,
			"methods":         methods,
		})
		return
	}

	// Fully authenticated.
	pair := h.finalizeLogin(c, user, model.AuthMethodPassword, model.MFAMethodNone)
	c.JSON(http.StatusOK, pair)
}

// loginRuleRequiresMFA reads the user_login rule's Spec for {"require_mfa":true}.
func loginRuleRequiresMFA(r *model.AccessRule) bool {
	if r == nil || r.Spec == "" {
		return false
	}
	var s struct {
		RequireMFA bool `json:"require_mfa"`
	}
	_ = json.Unmarshal([]byte(r.Spec), &s)
	return s.RequireMFA
}

func (h *AuthHandler) availableMFA(ctx context.Context, user *model.User) ([]string, error) {
	rows, err := h.MFA.ListEnabled(ctx, user.ID)
	if err != nil {
		return nil, err
	}
	seen := map[string]bool{}
	out := []string{}
	for _, r := range rows {
		if !seen[string(r.Type)] {
			out = append(out, string(r.Type))
			seen[string(r.Type)] = true
		}
	}
	// Add email OTP if the user has an email + enabled an email factor.
	if seen["email"] && user.Email == "" {
		// Email factor exists but user has no email — drop it.
		filtered := out[:0]
		for _, m := range out {
			if m != "email" {
				filtered = append(filtered, m)
			}
		}
		out = filtered
	}
	// Always offer recovery if MFA is required.
	if len(out) > 0 {
		out = append(out, "recovery")
	}
	if user.MFAEnforced && len(out) == 0 {
		// Forced MFA but nothing enrolled — push them to enrol via the recovery path.
		return []string{"email"}, nil
	}
	return out, nil
}

// ----- Step 2 endpoints -----

type mfaSubmit struct {
	ChallengeToken string `json:"challenge_token" binding:"required"`
	Code           string `json:"code"`
}

func (h *AuthHandler) LoginTOTP(c *gin.Context) {
	user, ok := h.consumeChallenge(c, "totp")
	if !ok {
		return
	}
	var p mfaSubmit
	if err := c.ShouldBindJSON(&p); err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"error": err.Error()})
		return
	}
	if _, err := h.TOTP.Verify(c.Request.Context(), user.ID, p.Code); err != nil {
		h.recordHistory(c, &user.ID, user.Username, model.LoginMFAFailed, model.AuthMethodPassword, model.MFAMethodTOTP, err.Error())
		c.JSON(http.StatusUnauthorized, gin.H{"error": err.Error()})
		return
	}
	pair := h.finalizeLogin(c, user, model.AuthMethodPassword, model.MFAMethodTOTP)
	c.JSON(http.StatusOK, pair)
}

func (h *AuthHandler) LoginEmailOTPSend(c *gin.Context) {
	user, ok := h.consumeChallenge(c, "email")
	if !ok {
		return
	}
	if err := h.Email.Send(c.Request.Context(), user.ID, user.Email); err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"error": err.Error()})
		return
	}
	c.JSON(http.StatusOK, gin.H{"ok": true})
}

func (h *AuthHandler) LoginEmailOTP(c *gin.Context) {
	user, ok := h.consumeChallenge(c, "email")
	if !ok {
		return
	}
	var p mfaSubmit
	if err := c.ShouldBindJSON(&p); err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"error": err.Error()})
		return
	}
	if err := h.Email.Verify(c.Request.Context(), user.ID, p.Code); err != nil {
		h.recordHistory(c, &user.ID, user.Username, model.LoginMFAFailed, model.AuthMethodPassword, model.MFAMethodEmail, err.Error())
		c.JSON(http.StatusUnauthorized, gin.H{"error": err.Error()})
		return
	}
	pair := h.finalizeLogin(c, user, model.AuthMethodPassword, model.MFAMethodEmail)
	c.JSON(http.StatusOK, pair)
}

func (h *AuthHandler) LoginRecovery(c *gin.Context) {
	user, ok := h.consumeChallenge(c, "recovery")
	if !ok {
		return
	}
	var p mfaSubmit
	if err := c.ShouldBindJSON(&p); err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"error": err.Error()})
		return
	}
	if _, err := h.Recovery.Verify(c.Request.Context(), user.ID, p.Code); err != nil {
		h.recordHistory(c, &user.ID, user.Username, model.LoginMFAFailed, model.AuthMethodRecovery, model.MFAMethodRecovery, err.Error())
		c.JSON(http.StatusUnauthorized, gin.H{"error": err.Error()})
		return
	}
	pair := h.finalizeLogin(c, user, model.AuthMethodRecovery, model.MFAMethodRecovery)
	c.JSON(http.StatusOK, pair)
}

// consumeChallenge validates the challenge_token from the JSON body, returns
// the linked user, and aborts (writing the response) on failure.
func (h *AuthHandler) consumeChallenge(c *gin.Context, requiredMethod string) (*model.User, bool) {
	// Read the body once and immediately restore it, so the downstream handler
	// can still bind the full payload (challenge_token + code). The wrapper is
	// parsed off the captured bytes — decoding it via c.ShouldBindJSON here would
	// drain the request and leave the handler's second bind with an empty body
	// (EOF → 400).
	var raw []byte
	if c.Request.Body != nil {
		raw, _ = io.ReadAll(c.Request.Body)
	}
	c.Request.Body = io.NopCloser(bytes.NewReader(raw))

	var p struct {
		ChallengeToken string `json:"challenge_token"`
	}
	if err := json.Unmarshal(raw, &p); err != nil || p.ChallengeToken == "" {
		c.JSON(http.StatusBadRequest, gin.H{"error": "challenge_token required"})
		return nil, false
	}
	claims, err := h.Issuer.Parse(p.ChallengeToken)
	if err != nil || claims.Step != auth.AuthStepMFARequired {
		c.JSON(http.StatusUnauthorized, gin.H{"error": "invalid challenge token"})
		return nil, false
	}
	user, err := h.Users.FindByID(c.Request.Context(), claims.UserID)
	if err != nil || user == nil || user.Disabled {
		c.JSON(http.StatusUnauthorized, gin.H{"error": "user gone"})
		return nil, false
	}
	if requiredMethod != "" {
		allowed := false
		for _, m := range claims.Methods {
			if m == requiredMethod {
				allowed = true
				break
			}
		}
		if !allowed {
			c.JSON(http.StatusBadRequest, gin.H{"error": "method not allowed for this challenge"})
			return nil, false
		}
	}
	return user, true
}

// ----- Passkey login -----

type passkeyBeginReq struct {
	Username string `json:"username"`
}
type passkeyFinishReq struct {
	ChallengeID string                 `json:"challenge_id" binding:"required"`
	Assertion   map[string]interface{} `json:"assertion" binding:"required"`
}

func (h *AuthHandler) PasskeyBegin(c *gin.Context) {
	if h.Passkey == nil {
		c.JSON(http.StatusForbidden, gin.H{"error": "passkey not configured"})
		return
	}
	var p passkeyBeginReq
	_ = c.ShouldBindJSON(&p)
	chID, opts, err := h.Passkey.LoginBegin(c.Request.Context(), p.Username)
	if err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"error": err.Error()})
		return
	}
	c.JSON(http.StatusOK, gin.H{
		"challenge_id": chID,
		"options":      opts,
	})
}

func (h *AuthHandler) PasskeyFinish(c *gin.Context) {
	if h.Passkey == nil {
		c.JSON(http.StatusForbidden, gin.H{"error": "passkey not configured"})
		return
	}
	var p passkeyFinishReq
	if err := c.ShouldBindJSON(&p); err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"error": err.Error()})
		return
	}
	// We need to forward the raw assertion to go-webauthn — re-marshal it.
	body, _ := jsonMarshal(p.Assertion)
	user, err := h.Passkey.LoginFinish(c.Request.Context(), p.ChallengeID, body)
	if err != nil {
		h.recordHistory(c, nil, "", model.LoginFailed, model.AuthMethodPasskey, model.MFAMethodPasskey, err.Error())
		c.JSON(http.StatusUnauthorized, gin.H{"error": err.Error()})
		return
	}
	pair := h.finalizeLogin(c, user, model.AuthMethodPasskey, model.MFAMethodPasskey)
	c.JSON(http.StatusOK, pair)
}

// ----- OIDC -----

func (h *AuthHandler) Providers(c *gin.Context) {
	if h.OIDCRepo == nil {
		c.JSON(http.StatusOK, gin.H{"providers": []any{}})
		return
	}
	rows, err := h.OIDCRepo.ListEnabled(c.Request.Context())
	if err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": err.Error()})
		return
	}
	out := make([]gin.H, 0, len(rows))
	for _, r := range rows {
		out = append(out, gin.H{"name": r.Name, "display_name": r.DisplayName})
	}
	c.JSON(http.StatusOK, gin.H{"providers": out})
}

func (h *AuthHandler) OIDCLogin(c *gin.Context) {
	if h.OIDC == nil {
		c.JSON(http.StatusForbidden, gin.H{"error": "oidc not configured"})
		return
	}
	url, err := h.OIDC.AuthorizeURL(c.Request.Context(), c.Param("provider"))
	if err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"error": err.Error()})
		return
	}
	c.Redirect(http.StatusFound, url)
}

func (h *AuthHandler) OIDCCallback(c *gin.Context) {
	if h.OIDC == nil {
		c.JSON(http.StatusForbidden, gin.H{"error": "oidc not configured"})
		return
	}
	state := c.Query("state")
	code := c.Query("code")
	user, oc, err := h.OIDC.HandleCallback(c.Request.Context(), state, code, h.Users)
	if err != nil {
		h.recordHistory(c, nil, "", model.LoginFailed, model.AuthMethodOIDC, model.MFAMethodNone, err.Error())
		c.JSON(http.StatusUnauthorized, gin.H{"error": err.Error()})
		return
	}
	pair := h.finalizeLogin(c, user, model.AuthMethodOIDC, model.MFAMethodNone)
	if oc != nil {
		pair = withProvider(pair, oc.Name)
	}
	c.JSON(http.StatusOK, pair)
}

// ----- Logout -----

func (h *AuthHandler) Logout(c *gin.Context) {
	claims := auth.FromContext(c.Request.Context())
	if claims != nil && h.Blocklist != nil {
		_ = h.Blocklist.Revoke(c.Request.Context(), claims.ID, h.Issuer.AccessTTL())
	}
	c.JSON(http.StatusOK, gin.H{"ok": true})
}

// ----- Refresh -----

type refreshReq struct {
	RefreshToken string `json:"refresh_token" binding:"required"`
}

func (h *AuthHandler) Refresh(c *gin.Context) {
	var req refreshReq
	if err := c.ShouldBindJSON(&req); err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"error": err.Error()})
		return
	}
	claims, err := h.Issuer.Parse(req.RefreshToken)
	if err != nil || claims.Step != auth.AuthStepRefresh {
		c.JSON(http.StatusUnauthorized, gin.H{"error": "invalid refresh token"})
		return
	}
	if h.Blocklist != nil && h.Blocklist.IsRevoked(c.Request.Context(), claims.ID) {
		c.JSON(http.StatusUnauthorized, gin.H{"error": "refresh token revoked"})
		return
	}
	user, err := h.Users.FindByID(c.Request.Context(), claims.UserID)
	if err != nil || user == nil {
		c.JSON(http.StatusUnauthorized, gin.H{"error": "user gone"})
		return
	}
	pair, err := h.Issuer.Issue(auth.Claims{
		UserID: user.ID, Username: user.Username, Admin: user.IsAdmin, Step: auth.AuthStepActive,
	})
	if err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": err.Error()})
		return
	}
	c.JSON(http.StatusOK, pair)
}

// ----- Anonymous -----

// sandboxSpec is the honest, client-facing description of the ephemeral
// container a sandbox token buys: how long it lives and the resource walls it
// runs behind. The page renders the countdown and the limit chips from this.
type sandboxSpec struct {
	TTLSeconds int64    `json:"ttl_seconds"`
	Image      string   `json:"image"`
	MemoryMB   int64    `json:"memory_mb"`
	CPU        float64  `json:"cpu"`
	Network    string   `json:"network"`
	Shell      []string `json:"shell"`
}

// anonymousResponse embeds the token pair so existing access_token consumers
// keep working, and adds the sandbox spec alongside it.
type anonymousResponse struct {
	auth.TokenPair
	Sandbox sandboxSpec `json:"sandbox"`
}

// spec materialises the client-facing sandbox description from config.
func (h *AuthHandler) spec() sandboxSpec {
	shell := h.AnonSpec.Shell
	if len(shell) == 0 {
		shell = []string{"/bin/sh"}
	}
	return sandboxSpec{
		TTLSeconds: int64(h.AnonSpec.TTL.Seconds()),
		Image:      h.AnonSpec.Image,
		MemoryMB:   h.AnonSpec.MemoryMB,
		CPU:        h.AnonSpec.CPU,
		Network:    h.AnonSpec.Network,
		Shell:      shell,
	}
}

// AnonymousInfo is a public, token-free probe so the landing page can render an
// honest spec (and a friendly "disabled" state) before a visitor commits to
// minting a throwaway token.
func (h *AuthHandler) AnonymousInfo(c *gin.Context) {
	c.JSON(http.StatusOK, gin.H{"enabled": h.AnonEna, "sandbox": h.spec()})
}

func (h *AuthHandler) Anonymous(c *gin.Context) {
	if !h.AnonEna {
		c.JSON(http.StatusForbidden, gin.H{"error": "anonymous disabled"})
		return
	}
	pair, err := h.Issuer.Issue(auth.Claims{
		UserID: 0, Username: "anonymous-" + c.ClientIP(), Anonymous: true, Step: auth.AuthStepActive,
	})
	if err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": err.Error()})
		return
	}
	c.JSON(http.StatusOK, anonymousResponse{TokenPair: pair, Sandbox: h.spec()})
}

// ----- common helpers -----

func (h *AuthHandler) finalizeLogin(c *gin.Context, user *model.User, am model.AuthMethod, mm model.MFAMethod) auth.TokenPair {
	pair, err := h.Issuer.Issue(auth.Claims{
		UserID: user.ID, Username: user.Username, Admin: user.IsAdmin, Step: auth.AuthStepActive,
	})
	if err != nil {
		return auth.TokenPair{}
	}
	if h.Blocklist != nil {
		_ = h.Blocklist.Track(c.Request.Context(), user.ID, claimsJTI(pair.AccessToken, h.Issuer), h.Issuer.AccessTTL())
	}
	ip := c.ClientIP()
	ua := c.GetHeader("User-Agent")
	_ = h.Users.RecordLoginSuccess(c.Request.Context(), user.ID, ip, ua)

	// Score the login: resolves geo (always) + flags anomalies + fans security
	// notifications. Returns a zero Signal when the detector is unwired.
	var sig anomaly.Signal
	if h.Anomaly != nil {
		sig = h.Anomaly.Inspect(c.Request.Context(), user, ip, ua)
	}
	row := &model.LoginHistory{
		UserID:     &user.ID,
		Username:   user.Username,
		IP:         ip,
		UserAgent:  ua,
		Result:     model.LoginSuccess,
		AuthMethod: am, MFAMethod: mm,
		Anomaly:        sig.Anomalous,
		RiskScore:      sig.Score,
		AnomalyReasons: sig.ReasonsCSV(),
		CreatedAt:      time.Now(),
	}
	applyGeo(row, sig.Location)
	_ = h.History.Insert(c.Request.Context(), row)

	if h.Writer != nil {
		payload := "method=" + string(am)
		if mm != model.MFAMethodNone {
			payload += " mfa=" + string(mm)
		}
		if sig.Location.Country != "" {
			payload += " country=" + sig.Location.Country
		}
		if sig.Anomalous {
			payload += " anomaly=1 score=" + strconv.Itoa(sig.Score)
		}
		h.Writer.Log(model.AuditLog{
			Kind: model.AuditLogin, UserID: user.ID, Username: user.Username,
			ClientIP: ip, Payload: payload,
		})
		// A distinct, abnormal event for the audit center's 安全 surface so an
		// anomalous login is more than a sub-flag of a routine login row.
		if sig.Anomalous {
			h.Writer.Log(model.AuditLog{
				Kind: model.AuditAnomalyLogin, UserID: user.ID, Username: user.Username,
				ClientIP: ip,
				Payload:  "score=" + strconv.Itoa(sig.Score) + " reasons=" + sig.ReasonsCSV() + " loc=" + anomaly.FormatLocation(sig.Location),
			})
		}
	}
	return pair
}

// applyGeo copies a resolved geo location onto a login-history row.
func applyGeo(row *model.LoginHistory, loc geoip.Location) {
	row.GeoCountry = loc.Country
	row.GeoCountryISO = loc.CountryISO
	row.GeoRegion = loc.Region
	row.GeoCity = loc.City
	row.GeoLat = loc.Latitude
	row.GeoLon = loc.Longitude
	row.ASN = loc.ASN
	row.ASNOrg = loc.ASNOrg
}

func (h *AuthHandler) recordHistory(c *gin.Context, userID *uint64, username string, result model.LoginResult, am model.AuthMethod, mm model.MFAMethod, reason string) {
	if h.History == nil {
		return
	}
	ip := c.ClientIP()
	row := &model.LoginHistory{
		UserID:     userID,
		Username:   username,
		IP:         ip,
		UserAgent:  c.GetHeader("User-Agent"),
		Result:     result,
		AuthMethod: am, MFAMethod: mm,
		Reason:    reason,
		CreatedAt: time.Now(),
	}
	if h.Anomaly != nil {
		applyGeo(row, h.Anomaly.Geo(ip))
	}
	_ = h.History.Insert(c.Request.Context(), row)
	// Mirror failed / locked attempts into the audit trail's 认证 lane.
	if h.Writer != nil && (result == model.LoginFailed || result == model.LoginLocked || result == model.LoginMFAFailed) {
		var uid uint64
		if userID != nil {
			uid = *userID
		}
		h.Writer.Log(model.AuditLog{
			Kind: model.AuditLoginFailed, UserID: uid, Username: username,
			ClientIP: ip, Payload: "result=" + string(result) + " reason=" + reason,
		})
	}
	// Brute-force / credential-stuffing watch on failed attempts. InspectFailure
	// alerts (and emits) at most once per window; it fans notifications itself.
	if h.Anomaly != nil && (result == model.LoginFailed || result == model.LoginMFAFailed) {
		if alert, count := h.Anomaly.InspectFailure(c.Request.Context(), username, ip); alert && h.Writer != nil {
			var uid uint64
			if userID != nil {
				uid = *userID
			}
			_ = h.Writer.LogCritical(c.Request.Context(), model.AuditLog{
				Kind: model.AuditBruteForce, UserID: uid, Username: username,
				ClientIP: ip, Payload: "count=" + strconv.Itoa(count) + " window",
			})
		}
	}
}

func claimsJTI(token string, issuer *auth.Issuer) string {
	c, err := issuer.Parse(token)
	if err != nil {
		return ""
	}
	return c.ID
}

func withProvider(pair auth.TokenPair, name string) auth.TokenPair {
	// no-op placeholder so we can extend the response later
	return pair
}

func jsonMarshal(v any) ([]byte, error) { return json.Marshal(v) }

// keep context import alive (used implicitly via gin.Context.Request.Context)
var _ = context.Background
