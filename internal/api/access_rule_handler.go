package api

import (
	"net/http"
	"strconv"

	"github.com/gin-gonic/gin"
	"github.com/michongs/wayfort/internal/auth"
	"github.com/michongs/wayfort/internal/model"
	"github.com/michongs/wayfort/internal/repo"
	"github.com/michongs/wayfort/pkg/edition"
)

// AccessRuleHandler is the admin CRUD surface for the consolidated 访问控制 rule
// module. Authoring an X-Pack kind (review / masking / connection-method)
// requires the matching edition feature so the UI and API agree on what's
// available; the Community kinds (command_filter / user_login) are always editable.
type AccessRuleHandler struct {
	Repo    *repo.AccessRuleRepo
	Edition edition.Provider
}

var validRuleKinds = map[model.AccessRuleKind]bool{
	model.RuleCommandFilter:         true,
	model.RuleUserLogin:             true,
	model.RuleAssetConnectionReview: true,
	model.RuleDataMasking:           true,
	model.RuleConnectionMethod:      true,
}

var validRuleActions = map[model.AccessRuleAction]bool{
	model.ActionAccept: true,
	model.ActionDeny:   true,
	model.ActionReview: true,
	model.ActionNotify: true,
	model.ActionAlert:  true,
}

// kindFeature mirrors accesscontrol.kindFeature — the X-Pack feature each kind
// needs, or "" for Community kinds.
func ruleKindFeature(kind model.AccessRuleKind) string {
	switch kind {
	case model.RuleAssetConnectionReview:
		return edition.FeatureConnectionReview
	case model.RuleDataMasking:
		return edition.FeatureDataMasking
	case model.RuleConnectionMethod:
		return edition.FeatureConnectionMethod
	default:
		return ""
	}
}

// List — GET /access-rules?kind=...
func (h *AccessRuleHandler) List(c *gin.Context) {
	kind := model.AccessRuleKind(c.Query("kind"))
	if kind != "" && !validRuleKinds[kind] {
		c.JSON(http.StatusBadRequest, gin.H{"error": "未知规则类型"})
		return
	}
	rows, err := h.Repo.List(c.Request.Context(), kind)
	if err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": err.Error()})
		return
	}
	c.JSON(http.StatusOK, gin.H{"rules": rows})
}

type accessRuleInput struct {
	Kind        model.AccessRuleKind   `json:"kind"`
	Name        string                 `json:"name"`
	Description string                 `json:"description"`
	Priority    int                    `json:"priority"`
	Active      *bool                  `json:"active"`
	Users       string                 `json:"users"`
	Assets      string                 `json:"assets"`
	Accounts    string                 `json:"accounts"`
	IPRule      string                 `json:"ip_rule"`
	TimeWindow  string                 `json:"time_window"`
	Action      model.AccessRuleAction `json:"action"`
	Spec        string                 `json:"spec"`
}

func (in *accessRuleInput) validate() (int, string) {
	if !validRuleKinds[in.Kind] {
		return http.StatusBadRequest, "未知规则类型"
	}
	if in.Name == "" {
		return http.StatusBadRequest, "规则名称必填"
	}
	if !validRuleActions[in.Action] {
		return http.StatusBadRequest, "未知动作"
	}
	if in.Priority < 1 || in.Priority > 100 {
		return http.StatusBadRequest, "优先级需在 1~100"
	}
	return 0, ""
}

func (h *AccessRuleHandler) requireFeatureFor(c *gin.Context, kind model.AccessRuleKind) bool {
	feat := ruleKindFeature(kind)
	if feat == "" {
		return true
	}
	if h.Edition != nil && h.Edition.Has(feat) {
		return true
	}
	c.JSON(http.StatusPaymentRequired, gin.H{"error": "该规则类型需要更高版本授权", "feature": feat})
	return false
}

// Create — POST /access-rules
func (h *AccessRuleHandler) Create(c *gin.Context) {
	var in accessRuleInput
	if err := c.ShouldBindJSON(&in); err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"error": "请求格式错误"})
		return
	}
	if in.Priority == 0 {
		in.Priority = 50
	}
	if code, msg := in.validate(); code != 0 {
		c.JSON(code, gin.H{"error": msg})
		return
	}
	if !h.requireFeatureFor(c, in.Kind) {
		return
	}
	rule := &model.AccessRule{
		Kind: in.Kind, Name: in.Name, Description: in.Description,
		Priority: in.Priority, Active: in.Active == nil || *in.Active,
		Users: in.Users, Assets: in.Assets, Accounts: in.Accounts,
		IPRule: in.IPRule, TimeWindow: in.TimeWindow,
		Action: in.Action, Spec: in.Spec,
	}
	if claims := auth.FromContext(c.Request.Context()); claims != nil {
		rule.CreatedBy = claims.UserID
	}
	if err := h.Repo.Create(c.Request.Context(), rule); err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": err.Error()})
		return
	}
	c.JSON(http.StatusOK, rule)
}

// Update — PATCH /access-rules/:id
func (h *AccessRuleHandler) Update(c *gin.Context) {
	id, err := strconv.ParseUint(c.Param("id"), 10, 64)
	if err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"error": "无效 id"})
		return
	}
	existing, err := h.Repo.Get(c.Request.Context(), id)
	if err != nil {
		c.JSON(http.StatusNotFound, gin.H{"error": "规则不存在"})
		return
	}
	var in accessRuleInput
	if err := c.ShouldBindJSON(&in); err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"error": "请求格式错误"})
		return
	}
	// Kind is immutable on update; keep the stored kind.
	in.Kind = existing.Kind
	if in.Priority == 0 {
		in.Priority = existing.Priority
	}
	if code, msg := in.validate(); code != 0 {
		c.JSON(code, gin.H{"error": msg})
		return
	}
	if !h.requireFeatureFor(c, existing.Kind) {
		return
	}
	existing.Name = in.Name
	existing.Description = in.Description
	existing.Priority = in.Priority
	if in.Active != nil {
		existing.Active = *in.Active
	}
	existing.Users = in.Users
	existing.Assets = in.Assets
	existing.Accounts = in.Accounts
	existing.IPRule = in.IPRule
	existing.TimeWindow = in.TimeWindow
	existing.Action = in.Action
	existing.Spec = in.Spec
	if err := h.Repo.Update(c.Request.Context(), existing); err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": err.Error()})
		return
	}
	c.JSON(http.StatusOK, existing)
}

// Delete — DELETE /access-rules/:id
func (h *AccessRuleHandler) Delete(c *gin.Context) {
	id, err := strconv.ParseUint(c.Param("id"), 10, 64)
	if err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"error": "无效 id"})
		return
	}
	existing, err := h.Repo.Get(c.Request.Context(), id)
	if err != nil {
		c.JSON(http.StatusNotFound, gin.H{"error": "规则不存在"})
		return
	}
	if existing.IsSystem {
		c.JSON(http.StatusForbidden, gin.H{"error": "系统内置规则不可删除"})
		return
	}
	if err := h.Repo.Delete(c.Request.Context(), id); err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": err.Error()})
		return
	}
	c.JSON(http.StatusOK, gin.H{"ok": true})
}
