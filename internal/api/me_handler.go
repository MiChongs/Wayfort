package api

import (
	"context"
	"io"
	"net/http"
	"strconv"

	"github.com/gin-gonic/gin"
	"github.com/michongs/jumpserver-anonymous/internal/asset"
	"github.com/michongs/jumpserver-anonymous/internal/auth"
	"github.com/michongs/jumpserver-anonymous/internal/mfa"
	"github.com/michongs/jumpserver-anonymous/internal/model"
	"github.com/michongs/jumpserver-anonymous/internal/passkey"
	"github.com/michongs/jumpserver-anonymous/internal/repo"
	"golang.org/x/crypto/bcrypt"
)

// MeHandler serves /api/v1/me/* endpoints — the user managing their own
// account: profile, password, MFA factors, Passkeys, favorites, recent nodes.
type MeHandler struct {
	Users     *repo.UserRepo
	MFA       *repo.UserMFARepo
	WebAuthn  *passkey.Service
	TOTP      *mfa.TOTPService
	Email     *mfa.EmailOTPService
	Recovery  *mfa.RecoveryService
	Favorites *repo.FavoriteRepo
	Recent    *repo.RecentRepo
	History   *repo.LoginHistoryRepo
	Nodes     *repo.NodeRepo
	Tags      *repo.TagRepo
	Resolver  *asset.Resolver
}

// --- Profile ---

func (h *MeHandler) Profile(c *gin.Context) {
	claims := auth.FromContext(c.Request.Context())
	user, err := h.Users.FindByID(c.Request.Context(), claims.UserID)
	if err != nil || user == nil {
		c.JSON(http.StatusNotFound, gin.H{"error": "not found"})
		return
	}
	c.JSON(http.StatusOK, user)
}

type profileUpdate struct {
	DisplayName string `json:"display_name"`
	Email       string `json:"email"`
	Phone       string `json:"phone"`
}

func (h *MeHandler) UpdateProfile(c *gin.Context) {
	claims := auth.FromContext(c.Request.Context())
	user, err := h.Users.FindByID(c.Request.Context(), claims.UserID)
	if err != nil || user == nil {
		c.JSON(http.StatusNotFound, gin.H{"error": "not found"})
		return
	}
	var p profileUpdate
	if err := c.ShouldBindJSON(&p); err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"error": err.Error()})
		return
	}
	if p.DisplayName != "" {
		user.DisplayName = p.DisplayName
	}
	if p.Email != "" {
		user.Email = p.Email
	}
	user.Phone = p.Phone
	if err := h.Users.Update(c.Request.Context(), user); err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": err.Error()})
		return
	}
	c.JSON(http.StatusOK, user)
}

type passwordChange struct {
	OldPassword string `json:"old_password"`
	NewPassword string `json:"new_password" binding:"required,min=8"`
}

func (h *MeHandler) ChangePassword(c *gin.Context) {
	claims := auth.FromContext(c.Request.Context())
	user, err := h.Users.FindByID(c.Request.Context(), claims.UserID)
	if err != nil || user == nil {
		c.JSON(http.StatusNotFound, gin.H{"error": "not found"})
		return
	}
	var p passwordChange
	if err := c.ShouldBindJSON(&p); err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"error": err.Error()})
		return
	}
	if err := bcrypt.CompareHashAndPassword([]byte(user.PasswordHash), []byte(p.OldPassword)); err != nil {
		c.JSON(http.StatusForbidden, gin.H{"error": "wrong current password"})
		return
	}
	hash, err := auth.HashPassword(p.NewPassword)
	if err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": err.Error()})
		return
	}
	if err := h.Users.UpdatePassword(c.Request.Context(), user.ID, hash); err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": err.Error()})
		return
	}
	c.JSON(http.StatusOK, gin.H{"ok": true})
}

// --- MFA ---

func (h *MeHandler) ListMFA(c *gin.Context) {
	claims := auth.FromContext(c.Request.Context())
	rows, err := h.MFA.ListByUser(c.Request.Context(), claims.UserID)
	if err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": err.Error()})
		return
	}
	c.JSON(http.StatusOK, gin.H{"mfa": rows})
}

func (h *MeHandler) BeginTOTP(c *gin.Context) {
	claims := auth.FromContext(c.Request.Context())
	user, _ := h.Users.FindByID(c.Request.Context(), claims.UserID)
	if user == nil {
		c.JSON(http.StatusNotFound, gin.H{"error": "user gone"})
		return
	}
	dn := c.DefaultQuery("name", "Authenticator")
	res, err := h.TOTP.BeginEnrolment(c.Request.Context(), user, dn)
	if err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": err.Error()})
		return
	}
	c.JSON(http.StatusOK, res)
}

type finishTOTPReq struct {
	MFAID uint64 `json:"mfa_id" binding:"required"`
	Code  string `json:"code" binding:"required"`
}

func (h *MeHandler) FinishTOTP(c *gin.Context) {
	claims := auth.FromContext(c.Request.Context())
	var req finishTOTPReq
	if err := c.ShouldBindJSON(&req); err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"error": err.Error()})
		return
	}
	if err := h.TOTP.FinishEnrolment(c.Request.Context(), claims.UserID, req.MFAID, req.Code); err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"error": err.Error()})
		return
	}
	c.JSON(http.StatusOK, gin.H{"ok": true})
}

func (h *MeHandler) DeleteMFA(c *gin.Context) {
	claims := auth.FromContext(c.Request.Context())
	id, _ := strconv.ParseUint(c.Param("id"), 10, 64)
	if err := h.MFA.Delete(c.Request.Context(), id, claims.UserID); err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": err.Error()})
		return
	}
	c.JSON(http.StatusOK, gin.H{"ok": true})
}

func (h *MeHandler) RegenerateRecoveryCodes(c *gin.Context) {
	claims := auth.FromContext(c.Request.Context())
	codes, err := h.Recovery.Generate(c.Request.Context(), claims.UserID)
	if err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": err.Error()})
		return
	}
	c.JSON(http.StatusOK, gin.H{"codes": codes})
}

// --- Passkey self management ---

func (h *MeHandler) ListPasskeys(c *gin.Context) {
	claims := auth.FromContext(c.Request.Context())
	rows, err := h.WebAuthn.ListByUser(c.Request.Context(), claims.UserID)
	if err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": err.Error()})
		return
	}
	c.JSON(http.StatusOK, gin.H{"passkeys": rows})
}

func (h *MeHandler) BeginPasskeyRegister(c *gin.Context) {
	claims := auth.FromContext(c.Request.Context())
	user, _ := h.Users.FindByID(c.Request.Context(), claims.UserID)
	if user == nil {
		c.JSON(http.StatusNotFound, gin.H{"error": "user gone"})
		return
	}
	opts, err := h.WebAuthn.BeginRegistration(c.Request.Context(), user, c.DefaultQuery("name", "Passkey"))
	if err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": err.Error()})
		return
	}
	c.JSON(http.StatusOK, opts)
}

func (h *MeHandler) FinishPasskeyRegister(c *gin.Context) {
	claims := auth.FromContext(c.Request.Context())
	user, _ := h.Users.FindByID(c.Request.Context(), claims.UserID)
	if user == nil {
		c.JSON(http.StatusNotFound, gin.H{"error": "user gone"})
		return
	}
	body, err := io.ReadAll(c.Request.Body)
	if err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"error": err.Error()})
		return
	}
	cred, err := h.WebAuthn.FinishRegistration(c.Request.Context(), user, c.DefaultQuery("name", "Passkey"), body)
	if err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"error": err.Error()})
		return
	}
	c.JSON(http.StatusOK, cred)
}

func (h *MeHandler) DeletePasskey(c *gin.Context) {
	claims := auth.FromContext(c.Request.Context())
	id, _ := strconv.ParseUint(c.Param("id"), 10, 64)
	if err := h.WebAuthn.DeleteCredential(c.Request.Context(), claims.UserID, id); err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": err.Error()})
		return
	}
	c.JSON(http.StatusOK, gin.H{"ok": true})
}

// --- Favorites / Recent ---

func (h *MeHandler) ListFavorites(c *gin.Context) {
	claims := auth.FromContext(c.Request.Context())
	ids, err := h.Favorites.ListNodeIDs(c.Request.Context(), claims.UserID)
	if err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": err.Error()})
		return
	}
	c.JSON(http.StatusOK, gin.H{"node_ids": ids})
}

func (h *MeHandler) AddFavorite(c *gin.Context) {
	claims := auth.FromContext(c.Request.Context())
	nid, _ := strconv.ParseUint(c.Param("node_id"), 10, 64)
	if err := h.Favorites.Add(c.Request.Context(), claims.UserID, nid); err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": err.Error()})
		return
	}
	c.JSON(http.StatusOK, gin.H{"ok": true})
}

func (h *MeHandler) RemoveFavorite(c *gin.Context) {
	claims := auth.FromContext(c.Request.Context())
	nid, _ := strconv.ParseUint(c.Param("node_id"), 10, 64)
	if err := h.Favorites.Remove(c.Request.Context(), claims.UserID, nid); err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": err.Error()})
		return
	}
	c.JSON(http.StatusOK, gin.H{"ok": true})
}

func (h *MeHandler) RecentNodes(c *gin.Context) {
	claims := auth.FromContext(c.Request.Context())
	limit, _ := strconv.Atoi(c.DefaultQuery("limit", "20"))
	rows, err := h.Recent.ListByUser(c.Request.Context(), claims.UserID, limit)
	if err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": err.Error()})
		return
	}
	c.JSON(http.StatusOK, gin.H{"recent": rows})
}

// --- Login history (self) ---

func (h *MeHandler) LoginHistory(c *gin.Context) {
	claims := auth.FromContext(c.Request.Context())
	limit, _ := strconv.Atoi(c.DefaultQuery("limit", "50"))
	rows, err := h.History.ListByUser(c.Request.Context(), claims.UserID, limit)
	if err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": err.Error()})
		return
	}
	c.JSON(http.StatusOK, gin.H{"history": rows})
}

// --- Visible nodes (RBAC-filtered list) ---

func (h *MeHandler) VisibleNodes(c *gin.Context) {
	claims := auth.FromContext(c.Request.Context())
	ids, all, err := h.Resolver.VisibleNodeIDs(c.Request.Context(), claims.UserID, asset.ActionConnect)
	if err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": err.Error()})
		return
	}
	if all {
		rows, err := h.Nodes.List(c.Request.Context())
		if err != nil {
			c.JSON(http.StatusInternalServerError, gin.H{"error": err.Error()})
			return
		}
		c.JSON(http.StatusOK, gin.H{"nodes": h.withTags(c.Request.Context(), rows), "scope": "all"})
		return
	}
	if len(ids) == 0 {
		c.JSON(http.StatusOK, gin.H{"nodes": []any{}, "scope": "scoped"})
		return
	}
	all_rows, err := h.Nodes.List(c.Request.Context())
	if err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": err.Error()})
		return
	}
	wanted := make(map[uint64]struct{}, len(ids))
	for _, id := range ids {
		wanted[id] = struct{}{}
	}
	filtered := all_rows[:0]
	for _, r := range all_rows {
		if _, ok := wanted[r.ID]; ok {
			filtered = append(filtered, r)
		}
	}
	c.JSON(http.StatusOK, gin.H{"nodes": h.withTags(c.Request.Context(), filtered), "scope": "scoped"})
}

// withTags decorates node rows with their managed colour tags so the user-facing
// node grid renders the same colourful chips as the admin views.
func (h *MeHandler) withTags(ctx context.Context, rows []model.Node) []meNodeView {
	out := make([]meNodeView, len(rows))
	for i, n := range rows {
		out[i] = meNodeView{Node: n, TagList: []model.AssetTag{}}
	}
	if h.Tags == nil || len(rows) == 0 {
		return out
	}
	ids := make([]uint64, len(rows))
	for i, n := range rows {
		ids[i] = n.ID
	}
	if byNode, err := h.Tags.TagsForNodes(ctx, ids); err == nil {
		for i := range out {
			if tl := byNode[out[i].ID]; tl != nil {
				out[i].TagList = tl
			}
		}
	}
	return out
}

// meNodeView is the node projection for the user-facing list: the node plus its
// colour tags (the freetext `tags` cache still rides along for search).
type meNodeView struct {
	model.Node
	TagList []model.AssetTag `json:"tag_list"`
}
