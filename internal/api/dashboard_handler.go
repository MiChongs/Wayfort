package api

import (
	"net/http"
	"sort"
	"time"

	"github.com/gin-gonic/gin"
	"github.com/michongs/jumpserver-anonymous/internal/asset"
	"github.com/michongs/jumpserver-anonymous/internal/auth"
	"github.com/michongs/jumpserver-anonymous/internal/model"
	"gorm.io/gorm"
)

// DashboardHandler serves the role-aware access descriptor (/me/access) and the
// tier-differentiated dashboard aggregate (/dashboard). Both read the caller's
// permission set via the RBAC resolver and branch on the resulting tier.
type DashboardHandler struct {
	DB    *gorm.DB
	RBAC  *auth.Resolver
	Asset *asset.Resolver
}

func (h *DashboardHandler) resolveTier(c *gin.Context) (tier string, perms []string) {
	claims := auth.FromContext(c.Request.Context())
	if claims == nil {
		return auth.TierUser, nil
	}
	set, _ := h.RBAC.Permissions(c.Request.Context(), claims.UserID)
	list := make([]string, 0, len(set))
	for k := range set {
		list = append(list, k)
	}
	sort.Strings(list)
	return auth.TierFor(set), list
}

// Access — GET /me/access. The single source of truth for the frontend's
// tier-based dashboard + nav gating.
func (h *DashboardHandler) Access(c *gin.Context) {
	tier, perms := h.resolveTier(c)
	c.JSON(http.StatusOK, gin.H{
		"tier":          tier,
		"is_superadmin": tier == auth.TierSuperadmin,
		"is_admin":      tier == auth.TierSuperadmin || tier == auth.TierAdmin,
		"permissions":   perms,
	})
}

type dashKV struct {
	Name  string `json:"name"`
	Value int    `json:"value"`
}
type dashDay struct {
	Date  string `json:"date"`
	Count int    `json:"count"`
}
type dashSession struct {
	ID        string    `json:"id"`
	Username  string    `json:"username"`
	NodeName  string    `json:"node_name"`
	Kind      string    `json:"kind"`
	Status    string    `json:"status"`
	StartedAt time.Time `json:"started_at"`
}

const dashWindowDays = 14

// Summary — GET /dashboard. Returns a system-wide view for admin/superadmin and
// a personal view for everyone else.
func (h *DashboardHandler) Summary(c *gin.Context) {
	claims := auth.FromContext(c.Request.Context())
	tier, _ := h.resolveTier(c)
	if tier == auth.TierSuperadmin || tier == auth.TierAdmin {
		h.adminSummary(c, tier)
		return
	}
	var uid uint64
	if claims != nil {
		uid = claims.UserID
	}
	h.userSummary(c, tier, uid)
}

func (h *DashboardHandler) adminSummary(c *gin.Context, tier string) {
	ctx := c.Request.Context()
	db := h.DB.WithContext(ctx)

	var users, nodes, creds, proxies, approvalsPending int64
	db.Model(&model.User{}).Count(&users)
	db.Model(&model.Node{}).Count(&nodes)
	db.Model(&model.Credential{}).Count(&creds)
	db.Model(&model.Proxy{}).Count(&proxies)
	db.Model(&model.ApprovalRequest{}).Where("status = ?", model.ApprovalReqPending).Count(&approvalsPending)

	var sessionsActive, sessionsTotal int64
	db.Model(&model.Session{}).Count(&sessionsTotal)
	db.Model(&model.Session{}).Where("status = ?", model.SessionActive).Count(&sessionsActive)

	var nodesDisabled int64
	db.Model(&model.Node{}).Where("disabled = ?", true).Count(&nodesDisabled)

	var auditToday int64
	dayStart := startOfToday()
	db.Model(&model.AuditLog{}).Where("created_at >= ?", dayStart).Count(&auditToday)

	rows := h.windowSessions(db, "", dashWindowDays)

	c.JSON(http.StatusOK, gin.H{
		"tier":  tier,
		"scope": "system",
		"stats": gin.H{
			"users":             users,
			"nodes":             nodes,
			"nodes_disabled":    nodesDisabled,
			"credentials":       creds,
			"proxies":           proxies,
			"sessions_active":   sessionsActive,
			"sessions_total":    sessionsTotal,
			"approvals_pending": approvalsPending,
			"audit_today":       auditToday,
		},
		"sessions_daily":     bucketDaily(rows, dashWindowDays),
		"sessions_by_kind":   bucketBy(rows, func(s model.Session) string { return string(s.Kind) }),
		"sessions_by_status": bucketBy(rows, func(s model.Session) string { return string(s.Status) }),
		"top_nodes":          topNodesAgg(rows, 6),
		"recent_sessions":    recentSessions(rows, 8),
	})
}

func (h *DashboardHandler) userSummary(c *gin.Context, tier string, uid uint64) {
	ctx := c.Request.Context()
	db := h.DB.WithContext(ctx)

	visibleNodes := 0
	if h.Asset != nil {
		ids, all, err := h.Asset.VisibleNodeIDs(ctx, uid, asset.ActionConnect)
		if err == nil {
			if all {
				var n int64
				db.Model(&model.Node{}).Where("disabled = ?", false).Count(&n)
				visibleNodes = int(n)
			} else {
				visibleNodes = len(ids)
			}
		}
	}

	var favorites, approvalsPending, sessions7d int64
	db.Model(&model.NodeFavorite{}).Where("user_id = ?", uid).Count(&favorites)
	db.Model(&model.ApprovalRequest{}).
		Where("requester_id = ? AND status = ?", uid, model.ApprovalReqPending).
		Count(&approvalsPending)
	db.Model(&model.Session{}).
		Where("user_id = ? AND started_at >= ?", uid, time.Now().AddDate(0, 0, -7)).
		Count(&sessions7d)

	rows := h.windowSessions(db, "user_id = "+u64(uid), dashWindowDays)

	c.JSON(http.StatusOK, gin.H{
		"tier":  tier,
		"scope": "personal",
		"stats": gin.H{
			"visible_nodes":     visibleNodes,
			"favorites":         favorites,
			"sessions_7d":       sessions7d,
			"approvals_pending": approvalsPending,
		},
		"sessions_daily":   bucketDaily(rows, dashWindowDays),
		"sessions_by_kind": bucketBy(rows, func(s model.Session) string { return string(s.Kind) }),
		"recent_sessions":  recentSessions(rows, 8),
	})
}

// windowSessions loads the lightweight session rows for the last N days,
// optionally constrained by a raw WHERE fragment (already-escaped — only used
// with a server-built user_id filter).
func (h *DashboardHandler) windowSessions(db *gorm.DB, extraWhere string, days int) []model.Session {
	since := time.Now().AddDate(0, 0, -(days - 1))
	q := db.Model(&model.Session{}).
		Select("id, username, node_name, kind, status, started_at").
		Where("started_at >= ?", since)
	if extraWhere != "" {
		q = q.Where(extraWhere)
	}
	var rows []model.Session
	q.Order("started_at desc").Limit(2000).Find(&rows)
	return rows
}

// --- aggregation helpers ---

func startOfToday() time.Time {
	n := time.Now()
	return time.Date(n.Year(), n.Month(), n.Day(), 0, 0, 0, 0, n.Location())
}

func bucketDaily(rows []model.Session, days int) []dashDay {
	counts := map[string]int{}
	for _, s := range rows {
		counts[s.StartedAt.Format("2006-01-02")]++
	}
	out := make([]dashDay, 0, days)
	now := time.Now()
	for i := days - 1; i >= 0; i-- {
		d := now.AddDate(0, 0, -i).Format("2006-01-02")
		out = append(out, dashDay{Date: d, Count: counts[d]})
	}
	return out
}

func bucketBy(rows []model.Session, key func(model.Session) string) []dashKV {
	m := map[string]int{}
	for _, s := range rows {
		k := key(s)
		if k == "" {
			k = "unknown"
		}
		m[k]++
	}
	out := make([]dashKV, 0, len(m))
	for k, v := range m {
		out = append(out, dashKV{Name: k, Value: v})
	}
	sort.Slice(out, func(i, j int) bool { return out[i].Value > out[j].Value })
	return out
}

func topNodesAgg(rows []model.Session, n int) []dashKV {
	m := map[string]int{}
	for _, s := range rows {
		if s.NodeName == "" {
			continue
		}
		m[s.NodeName]++
	}
	out := make([]dashKV, 0, len(m))
	for k, v := range m {
		out = append(out, dashKV{Name: k, Value: v})
	}
	sort.Slice(out, func(i, j int) bool { return out[i].Value > out[j].Value })
	if len(out) > n {
		out = out[:n]
	}
	return out
}

func recentSessions(rows []model.Session, n int) []dashSession {
	out := make([]dashSession, 0, n)
	for i, s := range rows {
		if i >= n {
			break
		}
		out = append(out, dashSession{
			ID: s.ID, Username: s.Username, NodeName: s.NodeName,
			Kind: string(s.Kind), Status: string(s.Status), StartedAt: s.StartedAt,
		})
	}
	return out
}

func u64(v uint64) string {
	const digits = "0123456789"
	if v == 0 {
		return "0"
	}
	var buf [20]byte
	i := len(buf)
	for v > 0 {
		i--
		buf[i] = digits[v%10]
		v /= 10
	}
	return string(buf[i:])
}
