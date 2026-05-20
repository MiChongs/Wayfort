// One module per resource would split this into 15 files; for the MVP we keep
// every typed service co-located, with light naming conventions. Each function
// is a thin wrapper around the api client so React Query can cache against
// stable URLs.

import { api, apiUpload, withTokenQuery, type UploadOptions } from "./client"
import type {
  AIAgent,
  AIConversation,
  AIMessage,
  AIProvider,
  AITool,
  AIToolInvocation,
  AssetGrant,
  AssetGroup,
  AssetTag,
  ChainTestResponse,
  ChainValidationResult,
  CommandHistoryRow,
  Credential,
  Department,
  DockerContainer,
  DockerImage,
  DockerLogsResponse,
  DockerStatus,
  FirewallDiagnostics,
  FirewallRule,
  FirewallRuleSpec,
  FirewallStatus,
  LoginHistory,
  MFADevice,
  Node,
  OIDCClient,
  Passkey,
  Permission,
  PortForward,
  Proxy,
  ProxyChainTemplate,
  Role,
  Session,
  Snippet,
  TerminalProfileRow,
  TokenPair,
  User,
  UserGroup,
} from "./types"

// ----- auth -----
export const authService = {
  login: (username: string, password: string) =>
    api<TokenPair | { step: string; challenge_token: string; expires_at: string; methods: string[] }>(
      "POST",
      "/auth/login",
      { body: { username, password } }
    ),
  loginTOTP: (challenge_token: string, code: string) =>
    api<TokenPair>("POST", "/auth/login/totp", { body: { challenge_token, code } }),
  loginRecovery: (challenge_token: string, code: string) =>
    api<TokenPair>("POST", "/auth/login/recovery", { body: { challenge_token, code } }),
  sendEmailOTP: (challenge_token: string) =>
    api<void>("POST", "/auth/login/email-otp/send", { body: { challenge_token } }),
  loginEmailOTP: (challenge_token: string, code: string) =>
    api<TokenPair>("POST", "/auth/login/email-otp", { body: { challenge_token, code } }),
  passkeyBegin: (username?: string) =>
    api<{ challenge_id: string; options: { publicKey: Record<string, unknown> } }>(
      "POST",
      "/auth/login/passkey/begin",
      { body: { username } }
    ),
  passkeyFinish: (challenge_id: string, assertion: unknown) =>
    api<TokenPair>("POST", "/auth/login/passkey/finish", { body: { challenge_id, assertion } }),
  refresh: (refresh_token: string) =>
    api<TokenPair>("POST", "/auth/refresh", { body: { refresh_token } }),
  logout: () => api<void>("POST", "/auth/logout"),
  anonymous: () => api<TokenPair>("POST", "/auth/anonymous"),
  providers: () => api<{ providers: { name: string; display_name: string }[] }>("GET", "/auth/providers"),
}

// ----- me -----
export const meService = {
  profile: () => api<User>("GET", "/me/profile"),
  updateProfile: (body: Partial<User>) => api<User>("PATCH", "/me/profile", { body }),
  changePassword: (old_password: string, new_password: string) =>
    api<void>("POST", "/me/password", { body: { old_password, new_password } }),
  loginHistory: (limit = 50) => api<{ history: LoginHistory[] }>("GET", "/me/login-history", { query: { limit } }),
  visibleNodes: () => api<{ nodes: Node[]; scope: "all" | "scoped" }>("GET", "/me/nodes"),
  favorites: () => api<{ node_ids: number[] }>("GET", "/me/favorites"),
  addFavorite: (nodeId: number) => api<void>("POST", `/me/favorites/${nodeId}`),
  removeFavorite: (nodeId: number) => api<void>("DELETE", `/me/favorites/${nodeId}`),
  recentNodes: (limit = 20) =>
    api<{ recent: { node_id: number; last_used_at: string; hits: number }[] }>("GET", "/me/recent-nodes", { query: { limit } }),
  mfa: {
    list: () => api<{ mfa: MFADevice[] }>("GET", "/me/mfa"),
    beginTOTP: (name: string) =>
      api<{ mfa_id: number; secret: string; otpauth_uri: string; qr_base64: string }>("POST", "/me/mfa/totp/begin", {
        query: { name },
      }),
    finishTOTP: (mfa_id: number, code: string) => api<void>("POST", "/me/mfa/totp/finish", { body: { mfa_id, code } }),
    remove: (id: number) => api<void>("DELETE", `/me/mfa/${id}`),
    regenerateRecovery: () => api<{ codes: string[] }>("POST", "/me/mfa/recovery-codes/regenerate"),
  },
  passkey: {
    list: () => api<{ passkeys: Passkey[] }>("GET", "/me/passkeys"),
    beginRegister: (name: string) =>
      api<{ publicKey: Record<string, unknown> }>("POST", "/me/passkeys/register/begin", { query: { name } }),
    finishRegister: (att: unknown, name: string) =>
      api<Passkey>("POST", "/me/passkeys/register/finish", { body: att, query: { name } }),
    remove: (id: number) => api<void>("DELETE", `/me/passkeys/${id}`),
  },
}

// ----- nodes / proxies / credentials -----
export const nodeService = {
  list: () => api<{ nodes: Node[] }>("GET", "/nodes"),
  get: (id: number) => api<Node>("GET", `/nodes/${id}`),
  create: (body: Partial<Node>) => api<Node>("POST", "/nodes", { body }),
  update: (id: number, body: Partial<Node>) => api<Node>("PATCH", `/nodes/${id}`, { body }),
  remove: (id: number) => api<void>("DELETE", `/nodes/${id}`),
}
export const proxyService = {
  list: () =>
    api<{
      proxies: Proxy[]
      summary?: {
        total: number
        by_kind: Record<string, number>
        kinds: string[]
      }
    }>("GET", "/proxies"),
  create: (body: Partial<Proxy>) => api<Proxy>("POST", "/proxies", { body }),
  update: (id: number, body: Partial<Proxy>) => api<Proxy>("PATCH", `/proxies/${id}`, { body }),
  remove: (id: number) => api<void>("DELETE", `/proxies/${id}`),
  // Phase 10 — chain validate / test.
  validateChain: (chain: string) =>
    api<ChainValidationResult>("POST", "/proxies/chains/validate", { body: { chain } }),
  testChain: (chain: string, target = "", timeoutSeconds = 10) =>
    api<ChainTestResponse>("POST", "/proxies/chains/test", {
      body: { chain, target, timeout_seconds: timeoutSeconds },
    }),
}

// Phase 10 — reusable proxy chain presets.
export const chainTemplateService = {
  list: () =>
    api<{ templates: ProxyChainTemplate[] }>("GET", "/proxies/chain-templates"),
  create: (body: { name: string; description?: string; chain: string; tags?: string }) =>
    api<ProxyChainTemplate>("POST", "/proxies/chain-templates", { body }),
  update: (id: number, body: Partial<{ name: string; description: string; chain: string; tags: string }>) =>
    api<ProxyChainTemplate>("PATCH", `/proxies/chain-templates/${id}`, { body }),
  remove: (id: number) => api<void>("DELETE", `/proxies/chain-templates/${id}`),
}
export const credentialService = {
  list: () => api<{ credentials: Credential[] }>("GET", "/credentials"),
  create: (body: { name: string; kind: string; username: string; secret: string; passphrase?: string }) =>
    api<{ id: number }>("POST", "/credentials", { body }),
  update: (id: number, body: { name?: string; kind?: string; username?: string; secret?: string }) =>
    api<{ id: number }>("PATCH", `/credentials/${id}`, { body }),
  remove: (id: number) => api<void>("DELETE", `/credentials/${id}`),
}

// ----- Phase 11 — terminal personalization -----
export const snippetService = {
  list: () => api<{ snippets: Snippet[] }>("GET", "/me/snippets"),
  create: (body: { name: string; description?: string; body: string; tags?: string; pinned?: boolean }) =>
    api<Snippet>("POST", "/me/snippets", { body }),
  update: (
    id: number,
    body: Partial<{ name: string; description: string; body: string; tags: string; pinned: boolean }>,
  ) => api<Snippet>("PATCH", `/me/snippets/${id}`, { body }),
  remove: (id: number) => api<void>("DELETE", `/me/snippets/${id}`),
  use: (id: number, variables: Record<string, string> = {}) =>
    api<{ resolved: string; snippet: Snippet }>("POST", `/me/snippets/${id}/use`, { body: { variables } }),
}

export const commandHistoryService = {
  list: (opts: { q?: string; node_id?: number; limit?: number } = {}) =>
    api<{ history: CommandHistoryRow[] }>("GET", "/me/command-history", { query: opts }),
  record: (body: {
    node_id?: number
    session_id?: string
    command: string
    exit_code?: number
    duration_ms?: number
    working_dir?: string
  }) => api<{ recorded: boolean; id?: number; reason?: string }>("POST", "/me/command-history", { body }),
  clear: (nodeId?: number) =>
    api<void>("DELETE", "/me/command-history", { query: nodeId ? { node_id: nodeId } : {} }),
}

export const terminalProfileService = {
  get: () => api<{ profile: TerminalProfileRow }>("GET", "/me/terminal-profile"),
  set: (body: { body?: unknown; history_enabled?: boolean }) =>
    api<{ profile: TerminalProfileRow }>("PATCH", "/me/terminal-profile", { body }),
}

// ----- sessions / port-forwards / sftp -----
export const sessionService = {
  list: (opts: { status?: string; node_id?: number; limit?: number; offset?: number } = {}) =>
    api<{ sessions: Session[] }>("GET", "/sessions", { query: opts }),
  recordingURL: (id: string) => withTokenQuery(`/api/proxy/api/v1/sessions/${id}/recording`),
}

// ----- Workspace v2 — firewall + docker services -----

export const firewallService = {
  status: (nodeId: number) =>
    api<FirewallStatus>("GET", `/nodes/${nodeId}/firewall/status`),
  listRules: (nodeId: number) =>
    api<{ rules: FirewallRule[] }>("GET", `/nodes/${nodeId}/firewall/rules`),
  diagnose: (nodeId: number) =>
    api<FirewallDiagnostics>("GET", `/nodes/${nodeId}/firewall/diagnose`),
  addRule: (nodeId: number, spec: FirewallRuleSpec) =>
    api<{ ok: boolean }>("POST", `/nodes/${nodeId}/firewall/rules`, { body: spec }),
  deleteRule: (nodeId: number, index: number) =>
    api<{ ok: boolean }>("DELETE", `/nodes/${nodeId}/firewall/rules/${index}`),
  enable: (nodeId: number) =>
    api<{ ok: boolean }>("POST", `/nodes/${nodeId}/firewall/enable`),
  disable: (nodeId: number) =>
    api<{ ok: boolean }>("POST", `/nodes/${nodeId}/firewall/disable`),
}

export const dockerService = {
  status: (nodeId: number) =>
    api<DockerStatus>("GET", `/nodes/${nodeId}/docker/status`),
  listContainers: (nodeId: number) =>
    api<{ containers: DockerContainer[] }>("GET", `/nodes/${nodeId}/docker/containers`),
  listImages: (nodeId: number) =>
    api<{ images: DockerImage[] }>("GET", `/nodes/${nodeId}/docker/images`),
  logs: (nodeId: number, cid: string, tail = 500) =>
    api<DockerLogsResponse>("GET", `/nodes/${nodeId}/docker/containers/${cid}/logs`, {
      query: { tail },
    }),
  start: (nodeId: number, cid: string) =>
    api<{ ok: boolean }>("POST", `/nodes/${nodeId}/docker/containers/${cid}/start`),
  stop: (nodeId: number, cid: string) =>
    api<{ ok: boolean }>("POST", `/nodes/${nodeId}/docker/containers/${cid}/stop`),
  restart: (nodeId: number, cid: string) =>
    api<{ ok: boolean }>("POST", `/nodes/${nodeId}/docker/containers/${cid}/restart`),
  remove: (nodeId: number, cid: string, force = false) =>
    api<{ ok: boolean }>("DELETE", `/nodes/${nodeId}/docker/containers/${cid}`, {
      query: force ? { force: "true" } : undefined,
    }),
}

export const portfwdService = {
  list: () => api<{ port_forwards: PortForward[] }>("GET", "/portforward"),
  create: (node_id: number, ttl?: string) => api<PortForward>("POST", "/portforward", { body: { node_id, ttl } }),
  remove: (id: string) => api<void>("DELETE", `/portforward/${id}`),
}

export type SftpEntry = {
  name: string
  path: string
  size: number
  mode: string
  mode_octal: string
  is_dir: boolean
  is_link: boolean
  link_target?: string
  uid?: number
  gid?: number
  owner?: string
  group?: string
  mod_time: string
}
export type SftpReadResponse = {
  path: string
  size: number
  content: string
  truncated: boolean
  mode?: string
}
export const sftpService = {
  list: (nodeId: number, path = "/") =>
    api<{ path: string; entries: SftpEntry[] }>("GET", `/nodes/${nodeId}/sftp/ls`, { query: { path } }),
  stat: (nodeId: number, path: string) =>
    api<SftpEntry>("GET", `/nodes/${nodeId}/sftp/stat`, { query: { path } }),
  mkdir: (nodeId: number, path: string) =>
    api<{ ok: boolean; path: string }>("POST", `/nodes/${nodeId}/sftp/mkdir`, { body: { path } }),
  remove: (nodeId: number, path: string) =>
    api<{ ok: boolean }>("DELETE", `/nodes/${nodeId}/sftp/rm`, { query: { path } }),
  rename: (nodeId: number, from: string, to: string) =>
    api<{ ok: boolean; from: string; to: string }>("POST", `/nodes/${nodeId}/sftp/rename`, {
      body: { from, to },
    }),
  chmod: (nodeId: number, path: string, mode: number) =>
    api<{ ok: boolean; path: string; mode: number }>("POST", `/nodes/${nodeId}/sftp/chmod`, {
      body: { path, mode },
    }),
  readText: (nodeId: number, path: string) =>
    api<SftpReadResponse>("GET", `/nodes/${nodeId}/sftp/read`, { query: { path } }),
  writeText: (nodeId: number, path: string, content: string, mode?: number) =>
    api<{ ok: boolean; bytes: number; path: string }>("POST", `/nodes/${nodeId}/sftp/write`, {
      body: mode != null ? { path, content, mode } : { path, content },
    }),
  // Upload with optional onProgress callback and AbortSignal. The caller can
  // pass a custom filename through `name` (e.g. for folder-uploads that need
  // to flatten path segments).
  upload: (
    nodeId: number,
    path: string,
    file: File | Blob,
    opts: { name?: string; onProgress?: UploadOptions["onProgress"]; signal?: AbortSignal } = {},
  ) =>
    apiUpload<{ ok: boolean; bytes: number; path: string }>(
      `/nodes/${nodeId}/sftp/upload`,
      file,
      {
        query: { path, ...(opts.name ? { name: opts.name } : {}) },
        onProgress: opts.onProgress,
        signal: opts.signal,
      },
    ),
  downloadURL: (nodeId: number, path: string) =>
    withTokenQuery(`/api/proxy/api/v1/nodes/${nodeId}/sftp/download?path=${encodeURIComponent(path)}`),
}

// ----- users / roles / groups / departments (admin) -----
export const userService = {
  list: (opts: { search?: string; disabled?: "true" | "false"; department_id?: number; limit?: number; offset?: number } = {}) =>
    api<{ users: User[] }>("GET", "/users", { query: opts }),
  create: (body: Partial<User> & { password: string }) => api<User>("POST", "/users", { body }),
  update: (id: number, body: Partial<User>) => api<User>("PATCH", `/users/${id}`, { body }),
  remove: (id: number) => api<void>("DELETE", `/users/${id}`),
  resetPassword: (id: number, password: string) => api<void>("POST", `/users/${id}/reset-password`, { body: { password } }),
  unlock: (id: number) => api<void>("POST", `/users/${id}/unlock`),
  forceLogout: (id: number) => api<void>("POST", `/users/${id}/force-logout`),
  listRoles: (id: number) => api<{ roles: Role[] }>("GET", `/users/${id}/roles`),
  replaceRoles: (id: number, role_ids: number[]) => api<void>("PUT", `/users/${id}/roles`, { body: { role_ids } }),
}

export const roleService = {
  list: () => api<{ roles: Role[] }>("GET", "/roles"),
  create: (body: { name: string; description?: string; permissions?: string[] }) => api<Role>("POST", "/roles", { body }),
  update: (id: number, body: Partial<Role>) => api<Role>("PATCH", `/roles/${id}`, { body }),
  remove: (id: number) => api<void>("DELETE", `/roles/${id}`),
  permissions: () => api<{ permissions: Permission[] }>("GET", "/permissions"),
}

export const departmentService = {
  list: () => api<{ departments: Department[] }>("GET", "/departments"),
  create: (body: Partial<Department>) => api<Department>("POST", "/departments", { body }),
  update: (id: number, body: Partial<Department>) => api<Department>("PATCH", `/departments/${id}`, { body }),
  remove: (id: number) => api<void>("DELETE", `/departments/${id}`),
}

export const groupService = {
  list: () => api<{ groups: UserGroup[] }>("GET", "/groups"),
  create: (body: Partial<UserGroup>) => api<UserGroup>("POST", "/groups", { body }),
  update: (id: number, body: Partial<UserGroup>) => api<UserGroup>("PATCH", `/groups/${id}`, { body }),
  remove: (id: number) => api<void>("DELETE", `/groups/${id}`),
  members: (id: number) => api<{ user_ids: number[] }>("GET", `/groups/${id}/members`),
  addMember: (id: number, user_id: number) => api<void>("POST", `/groups/${id}/members`, { body: { user_id } }),
  removeMember: (id: number, uid: number) => api<void>("DELETE", `/groups/${id}/members/${uid}`),
}

// ----- asset orchestration -----
export const assetGroupService = {
  list: () => api<{ asset_groups: AssetGroup[] }>("GET", "/asset-groups"),
  create: (body: Partial<AssetGroup>) => api<AssetGroup>("POST", "/asset-groups", { body }),
  update: (id: number, body: Partial<AssetGroup>) => api<AssetGroup>("PATCH", `/asset-groups/${id}`, { body }),
  remove: (id: number) => api<void>("DELETE", `/asset-groups/${id}`),
  addNode: (id: number, node_id: number) => api<void>("POST", `/asset-groups/${id}/nodes`, { body: { node_id } }),
  removeNode: (id: number, nid: number) => api<void>("DELETE", `/asset-groups/${id}/nodes/${nid}`),
}
export const tagService = {
  list: () => api<{ tags: AssetTag[] }>("GET", "/tags"),
  create: (body: Partial<AssetTag>) => api<AssetTag>("POST", "/tags", { body }),
  remove: (id: number) => api<void>("DELETE", `/tags/${id}`),
  attach: (nodeId: number, tag_id: number) => api<void>("POST", `/nodes/${nodeId}/tags`, { body: { tag_id } }),
  detach: (nodeId: number, tagId: number) => api<void>("DELETE", `/nodes/${nodeId}/tags/${tagId}`),
}
export const grantService = {
  list: () => api<{ grants: AssetGrant[] }>("GET", "/asset-grants"),
  create: (body: Partial<AssetGrant>) => api<AssetGrant>("POST", "/asset-grants", { body }),
  remove: (id: number) => api<void>("DELETE", `/asset-grants/${id}`),
}

// ----- OIDC -----
export const oidcService = {
  list: () => api<{ oidc_clients: OIDCClient[] }>("GET", "/oidc-clients"),
  create: (body: Partial<OIDCClient> & { client_secret?: string }) =>
    api<{ id: number }>("POST", "/oidc-clients", { body }),
  update: (id: number, body: Partial<OIDCClient> & { client_secret?: string }) =>
    api<{ id: number }>("PATCH", `/oidc-clients/${id}`, { body }),
  remove: (id: number) => api<void>("DELETE", `/oidc-clients/${id}`),
}

// ----- AI -----
export const aiProviderService = {
  list: () => api<{ providers: AIProvider[] }>("GET", "/ai/providers"),
  create: (body: Partial<AIProvider> & { api_key: string }) =>
    api<{ id: number }>("POST", "/ai/providers", { body }),
  update: (id: number, body: Partial<AIProvider> & { api_key?: string }) =>
    api<{ id: number }>("PATCH", `/ai/providers/${id}`, { body }),
  remove: (id: number) => api<void>("DELETE", `/ai/providers/${id}`),
  test: (id: number) => api<{ ok: boolean }>("POST", `/ai/providers/${id}/test`),
  models: (id: number) =>
    api<{
      models: Array<{
        id: string
        label?: string
        context_window?: number
        max_output?: number
        tools?: boolean
        vision?: boolean
      }>
    }>("GET", `/ai/providers/${id}/models`),
}
export const aiAgentService = {
  list: () => api<{ agents: AIAgent[] }>("GET", "/ai/agents"),
  create: (body: Partial<AIAgent>) => api<{ id: number }>("POST", "/ai/agents", { body }),
  update: (id: number, body: Partial<AIAgent>) => api<{ id: number }>("PATCH", `/ai/agents/${id}`, { body }),
  remove: (id: number) => api<void>("DELETE", `/ai/agents/${id}`),
  tools: () => api<{ tools: AITool[] }>("GET", "/ai/tools"),
}
export const aiConversationService = {
  list: () => api<{ conversations: AIConversation[] }>("GET", "/ai/conversations"),
  search: (q: string) =>
    api<{ conversations: AIConversation[]; count: number; query: string }>(
      "GET",
      `/ai/conversations/search?q=${encodeURIComponent(q)}`,
    ),
  create: (body: { agent_id: number; provider_id?: number; model?: string; permission_mode?: string; title?: string }) =>
    api<AIConversation>("POST", "/ai/conversations", { body }),
  get: (id: string) =>
    api<{ conversation: AIConversation; messages: AIMessage[]; invocations: AIToolInvocation[] }>(
      "GET",
      `/ai/conversations/${id}`
    ),
  update: (
    id: string,
    body: Partial<AIConversation> & { reset_overrides?: boolean },
  ) => api<AIConversation>("PATCH", `/ai/conversations/${id}`, { body }),
  remove: (id: string) => api<void>("DELETE", `/ai/conversations/${id}`),
  cancel: (id: string) => api<void>("POST", `/ai/conversations/${id}/cancel`),
  approve: (id: string, invId: string) =>
    api<void>("POST", `/ai/conversations/${id}/invocations/${invId}/approve`),
  reject: (id: string, invId: string) =>
    api<void>("POST", `/ai/conversations/${id}/invocations/${invId}/reject`),
  editMessage: (id: string, msgId: number, text: string) =>
    api<{ ok: boolean; message_count: number; edited_message_id: number; text: string }>(
      "PATCH",
      `/ai/conversations/${id}/messages/${msgId}`,
      { body: { text } },
    ),
  exportMarkdownURL: (id: string) =>
    withTokenQuery(`/api/proxy/api/v1/ai/conversations/${id}/export.md`),
}

// ----- insights (Plan 14) -----
//
// Lives behind /nodes/<id>/ssh and polls these endpoints on a
// user-configurable interval to render the right-hand system dashboard.
// The shapes here mirror `internal/insights/types.go` field-by-field.
export type ProcessSort = "cpu" | "mem" | "rss" | "pid"

export interface InsightsHost {
  hostname: string
  os: string
  kernel: string
  arch: string
  distro: string
}
export interface InsightsCPU {
  model: string
  cores: number
  usage_pct: number
}
export interface InsightsMemory {
  total_kb: number
  used_kb: number
  free_kb: number
  buff_cache_kb: number
  available_kb: number
  swap_total_kb: number
  swap_used_kb: number
}
export interface InsightsDisk {
  mount: string
  fs: string
  total_kb: number
  used_kb: number
  avail_kb: number
  used_pct: number
  source?: string
}
export interface InsightsIface {
  name: string
  mac?: string
  ipv4?: string
  ipv6?: string
  oper_state: string
  rx_bytes: number
  tx_bytes: number
  rx_bps: number
  tx_bps: number
}
export interface SystemSnapshot {
  generated_at: string
  host: InsightsHost
  cpu: InsightsCPU
  memory: InsightsMemory
  load_avg: [number, number, number]
  uptime_sec: number
  disks: InsightsDisk[]
  interfaces: InsightsIface[]
  logged_in_users: number
  partial?: boolean
  notes?: string
}
export interface InsightsProcess {
  pid: number
  ppid: number
  user: string
  cpu_pct: number
  mem_pct: number
  rss_kb: number
  state: string
  comm: string
  args: string
}
export interface ProcessList {
  generated_at: string
  total: number
  processes: InsightsProcess[]
  sorted_by: ProcessSort
}
export interface NetListen {
  proto: string
  local_addr: string
  local_port: number
  pid?: number
  process?: string
}
export interface NetworkSnapshot {
  generated_at: string
  listeners: NetListen[]
  established: number
}

export const insightsService = {
  system: (nodeId: number) =>
    api<SystemSnapshot>("GET", `/nodes/${nodeId}/insights/system`),
  processes: (nodeId: number, sort: ProcessSort = "cpu", limit = 50) =>
    api<ProcessList>("GET", `/nodes/${nodeId}/insights/processes`, {
      query: { sort, limit },
    }),
  network: (nodeId: number) =>
    api<NetworkSnapshot>("GET", `/nodes/${nodeId}/insights/network`),
}

// ---------------- Phase 15/16 — Approval Service ----------------
//
// The approval surface is a small REST API rooted at /api/v1/approvals.
// Server-side authorization gates the admin endpoints (templates /
// subscriptions / audit dump); regular users can create their own
// requests, list their own + tasks-for-me, and verify the ledger chain.

import type {
  ApprovalEvent,
  ApprovalGrant,
  ApprovalRequest,
  ApprovalRequestDetail,
  ApprovalSubscription,
  ApprovalTask,
  ApprovalTemplate,
  ChainVerifyResult,
  ApprovalBusinessType,
  DBColumnInfo,
  DBExecResult,
  DBForeignKeyInfo,
  DBIndexInfo,
  DBProcessInfo,
  DBQueryResult,
  DBRowKey,
  DBSchemaInfo,
  DBTableStats,
} from "./types"

export type CreateApprovalRequestInput = {
  business_type: ApprovalBusinessType
  title: string
  reason: string
  resource_type?: string
  resource_id?: string
  payload?: Record<string, unknown>
  window_start?: string
  window_end?: string
}

export type CreateApprovalRequestOutput = {
  request: ApprovalRequest
  auto_approved: boolean
  grant?: ApprovalGrant
}

export const approvalService = {
  create: (body: CreateApprovalRequestInput) =>
    api<CreateApprovalRequestOutput>("POST", "/approvals", { body }),
  list: (query: {
    status?: string
    business_type?: string
    mine?: boolean
    limit?: number
    offset?: number
  } = {}) =>
    api<{ items: ApprovalRequest[]; total: number }>("GET", "/approvals", {
      query: {
        status: query.status,
        business_type: query.business_type,
        mine: query.mine ? "1" : undefined,
        limit: query.limit,
        offset: query.offset,
      },
    }),
  get: (id: string) => api<ApprovalRequestDetail>("GET", `/approvals/${id}`),
  cancel: (id: string, reason: string) =>
    api<{ ok: true }>("POST", `/approvals/${id}/cancel`, { body: { reason } }),
  verifyChain: (id: string) =>
    api<ChainVerifyResult>("GET", `/approvals/${id}/audit/verify`),
  myTasks: (limit = 50) =>
    api<{ items: ApprovalTask[] }>("GET", "/approvals/tasks/me", { query: { limit } }),
  approve: (taskId: number, comment: string) =>
    api<unknown>("POST", `/approvals/tasks/${taskId}/approve`, { body: { comment, approve: true } }),
  reject: (taskId: number, comment: string) =>
    api<unknown>("POST", `/approvals/tasks/${taskId}/reject`, { body: { comment, approve: false } }),
  delegate: (taskId: number, delegate_to_id: number, comment: string) =>
    api<{ task: ApprovalTask }>("POST", `/approvals/tasks/${taskId}/delegate`, {
      body: { delegate_to_id, comment },
    }),
  revokeGrant: (grantId: string, reason: string) =>
    api<{ ok: true }>("POST", `/approvals/grants/${grantId}/revoke`, { body: { reason } }),
  checkGrant: (query: {
    user_id: number
    resource_type: string
    resource_id: string
    action?: string
    business_type?: ApprovalBusinessType
  }) =>
    api<{ permitted: boolean; grant_id?: string; expires_at?: string }>(
      "GET",
      "/approvals/grants/check",
      { query: { ...query, business_type: query.business_type } }
    ),
  eventsSince: (since: number, limit = 200) =>
    api<{ items: ApprovalEvent[] }>("GET", "/approvals/audit/events", { query: { since, limit } }),
  templates: {
    list: () => api<{ items: ApprovalTemplate[] }>("GET", "/approvals/templates"),
    create: (body: Partial<ApprovalTemplate>) =>
      api<ApprovalTemplate>("POST", "/approvals/templates", { body }),
    update: (id: number, body: Partial<ApprovalTemplate>) =>
      api<ApprovalTemplate>("PATCH", `/approvals/templates/${id}`, { body }),
    remove: (id: number) => api<{ ok: true }>("DELETE", `/approvals/templates/${id}`),
  },
  subscriptions: {
    list: () =>
      api<{ items: ApprovalSubscription[] }>("GET", "/approvals/subscriptions"),
    create: (body: Partial<ApprovalSubscription>) =>
      api<ApprovalSubscription>("POST", "/approvals/subscriptions", { body }),
    update: (id: number, body: Partial<ApprovalSubscription>) =>
      api<ApprovalSubscription>("PATCH", `/approvals/subscriptions/${id}`, { body }),
    remove: (id: number) =>
      api<{ ok: true }>("DELETE", `/approvals/subscriptions/${id}`),
  },
}

// ---------------- Phase 17 — DB Studio ----------------

export const dbService = {
  ping: (nodeId: number, database?: string) =>
    api<{ ok: true }>("GET", `/nodes/${nodeId}/db/ping`, { query: { database } }),
  // Cluster-level DB list. Phase 17b — PostgreSQL connections are bound
  // to one DB at a time, so the UI needs this to populate the database
  // picker; subsequent schema / columns / rows calls forward the picked
  // name so each catalog gets its own pool.
  databases: (nodeId: number) =>
    api<{ databases: string[] }>("GET", `/nodes/${nodeId}/db/databases`),
  schema: (nodeId: number, database?: string) =>
    api<DBSchemaInfo>("GET", `/nodes/${nodeId}/db/schema`, { query: { database } }),
  columns: (nodeId: number, schema: string, table: string, database?: string) =>
    api<{ columns: DBColumnInfo[] }>("GET", `/nodes/${nodeId}/db/columns`, {
      query: { schema, table, database },
    }),
  indexes: (nodeId: number, schema: string, table: string, database?: string) =>
    api<{ indexes: DBIndexInfo[] }>("GET", `/nodes/${nodeId}/db/indexes`, {
      query: { schema, table, database },
    }),
  rows: (
    nodeId: number,
    schema: string,
    table: string,
    opts: { limit?: number; offset?: number; order_by?: string; order_dir?: "ASC" | "DESC"; database?: string } = {}
  ) =>
    api<DBQueryResult>("GET", `/nodes/${nodeId}/db/rows`, {
      query: { schema, table, ...opts },
    }),
  query: (
    nodeId: number,
    sql: string,
    opts: { limit?: number; args?: unknown[]; reason?: string; database?: string } = {}
  ) =>
    api<DBQueryResult>("POST", `/nodes/${nodeId}/db/query`, {
      body: { sql, args: opts.args, limit: opts.limit, reason: opts.reason, database: opts.database },
    }),
  exec: (nodeId: number, sql: string, opts: { args?: unknown[]; reason?: string; database?: string } = {}) =>
    api<DBExecResult>("POST", `/nodes/${nodeId}/db/exec`, {
      body: { sql, args: opts.args, reason: opts.reason, database: opts.database },
    }),
  // Phase 19 — table structure + row CRUD + EXPLAIN
  foreignKeys: (nodeId: number, schema: string, table: string, database?: string) =>
    api<{ foreign_keys: DBForeignKeyInfo[] }>("GET", `/nodes/${nodeId}/db/foreign_keys`, {
      query: { schema, table, database },
    }),
  stats: (nodeId: number, schema: string, table: string, database?: string) =>
    api<DBTableStats>("GET", `/nodes/${nodeId}/db/stats`, {
      query: { schema, table, database },
    }),
  ddl: (nodeId: number, schema: string, table: string, database?: string) =>
    api<{ ddl: string }>("GET", `/nodes/${nodeId}/db/ddl`, {
      query: { schema, table, database },
    }),
  explain: (nodeId: number, sql: string, opts: { analyze?: boolean; database?: string; reason?: string } = {}) =>
    api<DBQueryResult>("POST", `/nodes/${nodeId}/db/explain`, {
      body: { sql, analyze: opts.analyze, database: opts.database, reason: opts.reason },
    }),
  rowUpdate: (
    nodeId: number,
    schema: string,
    table: string,
    key: DBRowKey,
    setColumns: string[],
    setValues: unknown[],
    opts: { database?: string; reason?: string } = {}
  ) =>
    api<DBExecResult>("POST", `/nodes/${nodeId}/db/row/update`, {
      body: {
        schema, table,
        key_columns: key.columns, key_values: key.values,
        set_columns: setColumns, set_values: setValues,
        database: opts.database, reason: opts.reason,
      },
    }),
  rowInsert: (
    nodeId: number,
    schema: string,
    table: string,
    columns: string[],
    values: unknown[],
    opts: { database?: string; reason?: string } = {}
  ) =>
    api<DBExecResult>("POST", `/nodes/${nodeId}/db/row/insert`, {
      body: {
        schema, table,
        set_columns: columns, set_values: values,
        database: opts.database, reason: opts.reason,
      },
    }),
  rowDelete: (
    nodeId: number,
    schema: string,
    table: string,
    key: DBRowKey,
    opts: { database?: string; reason?: string } = {}
  ) =>
    api<DBExecResult>("POST", `/nodes/${nodeId}/db/row/delete`, {
      body: {
        schema, table,
        key_columns: key.columns, key_values: key.values,
        database: opts.database, reason: opts.reason,
      },
    }),
  // Phase 20 — running queries / cancel
  processes: (nodeId: number, database?: string) =>
    api<{ processes: DBProcessInfo[] }>("GET", `/nodes/${nodeId}/db/processes`, {
      query: { database },
    }),
  kill: (nodeId: number, pid: number, database?: string) =>
    api<{ cancelled: boolean }>("POST", `/nodes/${nodeId}/db/kill`, {
      query: { pid, database },
    }),
  // Returns the export URL for a download anchor; bearer token rides as
  // ?token=... so the browser's <a download> works without custom XHR
  // headers (withTokenQuery is the same helper sessions/recording uses).
  exportURL: (nodeId: number, opts: { schema: string; table: string; format: "csv" | "jsonl" | "sql"; database?: string; limit?: number }) => {
    const q = new URLSearchParams()
    q.set("schema", opts.schema)
    q.set("table", opts.table)
    q.set("format", opts.format)
    if (opts.database) q.set("database", opts.database)
    if (opts.limit && opts.limit > 0) q.set("limit", String(opts.limit))
    return withTokenQuery(`/api/proxy/api/v1/nodes/${nodeId}/db/export?${q.toString()}`)
  },
}
