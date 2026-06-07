package auth

// Permission codes are referenced throughout the API to gate operations.
// They are deliberately strings (and not iota) so they're stable across
// migrations and visible to operators in the UI.
const (
	// system / meta
	PermSystemAdmin = "system:admin"

	// nodes / assets
	PermNodeList   = "node:list"
	PermNodeRead   = "node:read"
	PermNodeCreate = "node:create"
	PermNodeUpdate = "node:update"
	PermNodeDelete = "node:delete"

	// proxies / credentials
	PermProxyManage      = "proxy:manage"
	PermCredentialManage = "credential:manage"

	// asset groups and grants
	PermAssetGroupManage = "asset_group:manage"
	PermTagManage        = "tag:manage"
	PermGrantManage      = "grant:manage"

	// sessions
	PermSessionList      = "session:list"
	PermSessionRead      = "session:read"
	PermSessionTerminate = "session:terminate"

	// audit & history
	PermAuditRead = "audit:read"

	// users / roles / orgs
	PermUserManage   = "user:manage"
	PermRoleManage   = "role:manage"
	PermGroupManage  = "group:manage"
	PermDeptManage   = "department:manage"
	PermOIDCManage   = "oidc:manage"
	PermPortForward  = "portforward:manage"

	// AI assistant
	PermAIUse           = "ai:use"           // open conversations against allowed agents
	PermAIAgentCreate   = "ai:agent:create"  // create personal agents
	PermAIAgentGlobal   = "ai:agent:global"  // create global agents (admin)
	PermAIProviderUser  = "ai:provider:user" // configure personal providers
	PermAIProviderGlobal = "ai:provider:global" // configure global providers (admin)

	// Server-management — gated mutations exposed by workspace v2 panels.
	// Reads (status / list rules / list containers) require ActionConnect on
	// the node and don't need extra permission. Writes require the matching
	// :manage code below.
	PermFirewallManage = "firewall:manage"
	PermDockerManage   = "docker:manage"

	// Phase 15 — Approval Service.
	// Any authenticated user can OPEN a request for themselves, so we do not
	// gate the create endpoint with a permission — the resource-level grant
	// check on the action the request unlocks is what stops abuse. The
	// permission codes here gate everything else: deciding (approving /
	// rejecting / delegating), managing templates and subscriptions, and
	// reading the tamper-evident audit ledger.
	PermApprovalDecide          = "approval:decide"           // approve / reject / delegate any task assigned to me
	PermApprovalAdmin           = "approval:admin"            // cancel / revoke any request or grant
	PermApprovalTemplateManage  = "approval:template:manage"  // CRUD templates
	PermApprovalSubscribeManage = "approval:subscribe:manage" // CRUD IM/Webhook integrations
	PermApprovalAuditRead       = "approval:audit:read"       // dump + verify the ledger
)

// AllPermissions is the catalogue that gets seeded into the DB on boot so the
// UI can render checkboxes for role editing.
var AllPermissions = []struct {
	Code        string
	Category    string
	Description string
}{
	{PermSystemAdmin, "system", "全部系统权限（超级管理员）"},
	{PermNodeList, "node", "查看节点列表"},
	{PermNodeRead, "node", "查看节点详情"},
	{PermNodeCreate, "node", "新建节点"},
	{PermNodeUpdate, "node", "编辑节点"},
	{PermNodeDelete, "node", "删除节点"},
	{PermProxyManage, "asset", "管理代理"},
	{PermCredentialManage, "asset", "管理凭据"},
	{PermAssetGroupManage, "asset", "管理资产组"},
	{PermTagManage, "asset", "管理标签"},
	{PermGrantManage, "asset", "管理资产授权"},
	{PermSessionList, "session", "查看会话列表"},
	{PermSessionRead, "session", "查看/回放会话"},
	{PermSessionTerminate, "session", "强制断开会话"},
	{PermAuditRead, "audit", "审计日志查阅"},
	{PermUserManage, "user", "管理用户"},
	{PermRoleManage, "user", "管理角色"},
	{PermGroupManage, "user", "管理用户组"},
	{PermDeptManage, "user", "管理部门"},
	{PermOIDCManage, "system", "管理 OIDC 客户端"},
	{PermPortForward, "session", "申请/管理端口转发"},
	{PermAIUse, "ai", "使用 AI 助手与可见 agent 对话"},
	{PermAIAgentCreate, "ai", "创建个人 AI agent"},
	{PermAIAgentGlobal, "ai", "创建/管理全局 AI agent（管理员）"},
	{PermAIProviderUser, "ai", "配置个人 AI 提供商"},
	{PermAIProviderGlobal, "ai", "配置全局 AI 提供商（管理员）"},
	{PermFirewallManage, "ops", "修改节点防火墙规则"},
	{PermDockerManage, "ops", "启停 / 删除节点 Docker 容器"},
	{PermApprovalDecide, "approval", "审批：批准 / 驳回 / 委托分配到自己的任务"},
	{PermApprovalAdmin, "approval", "审批：撤销请求 / 吊销 grant（管理员）"},
	{PermApprovalTemplateManage, "approval", "审批：管理审批模板（管理员）"},
	{PermApprovalSubscribeManage, "approval", "审批：管理 IM/Webhook 集成（管理员）"},
	{PermApprovalAuditRead, "approval", "审批：导出与验签审计账本"},
}

// BuiltinRoles are seeded on first boot and protected from deletion.
var BuiltinRoles = map[string][]string{
	"admin": {PermSystemAdmin},
	"operator": {
		PermNodeList, PermNodeRead, PermSessionList, PermSessionRead,
		PermPortForward, PermAssetGroupManage, PermTagManage,
		PermAIUse, PermAIAgentCreate, PermAIProviderUser,
		PermApprovalDecide,
	},
	"auditor": {
		PermNodeList, PermSessionList, PermSessionRead, PermAuditRead,
		PermAIUse,
		PermApprovalAuditRead,
	},
	"guest": {PermAIUse},
}

// HasSystem returns true when the permission set effectively grants everything.
func HasSystem(perms map[string]struct{}) bool {
	_, ok := perms[PermSystemAdmin]
	return ok
}

// Access tiers used by the frontend to pick a dashboard + gate nav. Three
// buckets derived purely from the permission set:
//   - superadmin: holds system:admin (the bootstrap root or the `admin` role)
//   - admin:      holds any management permission but NOT system:admin
//                 (e.g. the operator role, or a custom role with :manage perms)
//   - user:       everyone else (guest / AI-only / plain users)
const (
	TierSuperadmin = "superadmin"
	TierAdmin      = "admin"
	TierUser       = "user"
)

// adminTierPerms marks the holder as at least "admin" tier. Deliberately
// excludes plain read/list/use perms (node:list, session:list, ai:use, …) so a
// read-only operator stays a "user" unless they can actually manage something.
var adminTierPerms = []string{
	PermNodeCreate, PermNodeUpdate, PermNodeDelete,
	PermProxyManage, PermCredentialManage,
	PermAssetGroupManage, PermTagManage, PermGrantManage,
	PermSessionTerminate, PermAuditRead,
	PermUserManage, PermRoleManage, PermGroupManage, PermDeptManage, PermOIDCManage,
	PermFirewallManage, PermDockerManage,
	PermApprovalDecide, PermApprovalAdmin, PermApprovalTemplateManage,
	PermApprovalSubscribeManage, PermApprovalAuditRead,
	PermAIAgentGlobal, PermAIProviderGlobal,
}

// TierFor classifies a permission set into one of the three access tiers.
func TierFor(perms map[string]struct{}) string {
	if HasSystem(perms) {
		return TierSuperadmin
	}
	for _, p := range adminTierPerms {
		if _, ok := perms[p]; ok {
			return TierAdmin
		}
	}
	return TierUser
}
