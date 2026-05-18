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
  Role,
  Session,
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
  list: () => api<{ proxies: Proxy[] }>("GET", "/proxies"),
  create: (body: Partial<Proxy>) => api<Proxy>("POST", "/proxies", { body }),
  update: (id: number, body: Partial<Proxy>) => api<Proxy>("PATCH", `/proxies/${id}`, { body }),
  remove: (id: number) => api<void>("DELETE", `/proxies/${id}`),
}
export const credentialService = {
  list: () => api<{ credentials: Credential[] }>("GET", "/credentials"),
  create: (body: { name: string; kind: string; username: string; secret: string; passphrase?: string }) =>
    api<{ id: number }>("POST", "/credentials", { body }),
  update: (id: number, body: { name?: string; kind?: string; username?: string; secret?: string }) =>
    api<{ id: number }>("PATCH", `/credentials/${id}`, { body }),
  remove: (id: number) => api<void>("DELETE", `/credentials/${id}`),
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
