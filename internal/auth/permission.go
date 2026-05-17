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
}

// BuiltinRoles are seeded on first boot and protected from deletion.
var BuiltinRoles = map[string][]string{
	"admin": {PermSystemAdmin},
	"operator": {
		PermNodeList, PermNodeRead, PermSessionList, PermSessionRead,
		PermPortForward, PermAssetGroupManage, PermTagManage,
		PermAIUse, PermAIAgentCreate, PermAIProviderUser,
	},
	"auditor": {
		PermNodeList, PermSessionList, PermSessionRead, PermAuditRead,
		PermAIUse,
	},
	"guest": {PermAIUse},
}

// HasSystem returns true when the permission set effectively grants everything.
func HasSystem(perms map[string]struct{}) bool {
	_, ok := perms[PermSystemAdmin]
	return ok
}
