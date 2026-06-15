// One module per resource would split this into 15 files; for the MVP we keep
// every typed service co-located, with light naming conventions. Each function
// is a thin wrapper around the api client so React Query can cache against
// stable URLs.

import { api, apiUpload, buildURLFromAPI, withTokenQuery, type UploadOptions } from "./client"
import type {
  SettingsSchema,
  IntegrationStatus,
  SettingsAudit,
  Domain,
  GatewayAgent,
  AgentEnrollToken,
  AgentGatewayInfo,
  PKICAInfo,
  PKICertificate,
} from "./types"
import type {
  AIAgent,
  AIConversation,
  AIMessage,
  AIModel,
  AIProvider,
  AIProviderPreset,
  ProviderHealth,
  ProviderKind,
  AITask,
  AITool,
  AIToolInvocation,
  AIKnowledgeBase,
  AIDocument,
  AIMemory,
  KBIngestStatus,
  AccessExplanation,
  AccessInfo,
  WatermarkRuntime,
  DashboardSummary,
  NodeListParams,
  NodeTestResult,
  BatchResult,
  AssetGrant,
  AssetGroup,
  AssetTag,
  AssetTagGroup,
  AccessFolder,
  AccessItem,
  AccessTemplate,
  AccessTreeData,
  MyDirectory,
  GranteeKind,
  GranteeRef,
  SubjectAccessRow,
  SubjectKind,
  ChainTestResponse,
  ChainValidationResult,
  CommandHistoryRow,
  BulkRun,
  BulkRunResult,
  Credential,
  CredentialInput,
  CredentialUsage,
  CredentialTestResult,
  Department,
  DockerContainer,
  DockerImage,
  DockerLogsResponse,
  DockerStatus,
  DockerContainerDetail,
  DockerStats,
  DockerTop,
  DockerNetwork,
  DockerVolume,
  DockerActionResult,
  FirewallDiagnostics,
  FirewallRule,
  FirewallRuleSpec,
  FirewallStatus,
  FirewallRuleInsert,
  FirewallRuleEdit,
  FirewallRuleMove,
  FirewallProbe,
  FirewallApplyRequest,
  FirewallApplyPlan,
  FirewallArmResult,
  FirewallRulesetDump,
  ServicePreset,
  PolicyTemplate,
  ExposurePort,
  Fail2banStatus,
  SystemdStatus,
  SystemdUnit,
  SystemdDetail,
  SystemdJournal,
  SystemdVerb,
  ProcRow,
  ProcList,
  ProcDetail,
  ProcSignal,
  ProcSort,
  PerfSnapshot,
  PerfDmesg,
  LogList,
  LogTail,
  Hardware,
  KernelInfo,
  StorageInfo,
  NetInfo,
  NetDiagResult,
  NetDiagTool,
  CronInfo,
  PkgStatus,
  PkgUpdate,
  PkgSearchItem,
  PkgActionResult,
  PkgVerb,
  PkgInfo,
  SysUserInfo,
  SecReport,
  LoginHistory,
  MFADevice,
  Node,
  OssBucket,
  OssListResult,
  OssObjectMeta,
  OssProvider,
  OssStats,
  OIDCClient,
  Passkey,
  Permission,
  PortForward,
  Proxy,
  ProxyChainTemplate,
  ProxyFailoverGroup,
  ProxyHealthSnapshot,
  ProxyMetricsSnapshot,
  KnownHost,
  Role,
  SSHKey,
  Session,
  SessionStats,
  SessionPhase,
  SessionMetricSample,
  SessionLifecycle,
  AuditEvent,
  AuditLogRow,
  AuditStats,
  AuditQuery,
  AuditIntegrityReport,
  DriveInfo,
  DriveEntry,
  AnonymousSession,
  SandboxSpec,
  Snippet,
  TerminalProfileRow,
  TokenPair,
  User,
  UserDetail,
  UserGroup,
  UserStats,
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
  // Token-free probe: is the sandbox enabled, and what are its limits? Lets the
  // landing render honest spec chips (and a disabled state) before committing.
  sandboxInfo: () => api<{ enabled: boolean; sandbox: SandboxSpec }>("GET", "/auth/anonymous/info"),
  // Mints a throwaway anonymous token and returns it alongside the sandbox
  // spec (TTL + resource caps) the public sandbox page renders.
  anonymous: () => api<AnonymousSession>("POST", "/auth/anonymous"),
  providers: () => api<{ providers: { name: string; display_name: string }[] }>("GET", "/auth/providers"),
}

// ----- me -----
export const meService = {
  profile: () => api<User>("GET", "/me/profile"),
  // Role tier + permission set for dashboard + nav gating (server-computed).
  access: () => api<AccessInfo>("GET", "/me/access"),
  // Resolved anti-leak watermark policy + this user's masked identity.
  watermark: () => api<WatermarkRuntime>("GET", "/me/watermark"),
  updateProfile: (body: Partial<User>) => api<User>("PATCH", "/me/profile", { body }),
  changePassword: (old_password: string, new_password: string) =>
    api<void>("POST", "/me/password", { body: { old_password, new_password } }),
  loginHistory: (limit = 50) => api<{ history: LoginHistory[] }>("GET", "/me/login-history", { query: { limit } }),
  visibleNodes: () => api<{ nodes: Node[]; scope: "all" | "scoped" }>("GET", "/me/nodes"),
  // 我的目录：管理员为我（及我的组/部门）搭建的授权树（已按可连资产过滤、空文件夹裁剪）。
  directory: () => api<MyDirectory>("GET", "/me/directory"),
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
  // Server-side filtered/sorted list for the admin management table. Kept
  // separate from list() so existing `queryFn: nodeService.list` callers (which
  // must stay zero-arg) are unaffected.
  search: (params: NodeListParams = {}) =>
    api<{ nodes: Node[] }>("GET", "/nodes", { query: params as Record<string, string | undefined> }),
  get: (id: number) => api<Node>("GET", `/nodes/${id}`),
  create: (body: Partial<Node>) => api<Node>("POST", "/nodes", { body }),
  update: (id: number, body: Partial<Node>) => api<Node>("PATCH", `/nodes/${id}`, { body }),
  remove: (id: number) => api<void>("DELETE", `/nodes/${id}`),
  test: (id: number) => api<NodeTestResult>("POST", `/nodes/${id}/test`),
  // Bulk enable/disable from the asset console's batch bar.
  batchEnable: (ids: number[]) => api<{ ok: number }>("POST", "/nodes/batch/enable", { body: { ids } }),
  batchDisable: (ids: number[]) => api<{ ok: number }>("POST", "/nodes/batch/disable", { body: { ids } }),
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
  // Live health — snapshot + SSE stream URL + on-demand probe.
  health: () => api<ProxyHealthSnapshot>("GET", "/proxies/health"),
  healthStreamURL: () => buildURLFromAPI("/proxies/health/stream"),
  probeNow: () => api<ProxyHealthSnapshot>("POST", "/proxies/health/probe"),
  // Connection metrics — snapshot + SSE stream URL.
  metrics: () => api<ProxyMetricsSnapshot>("GET", "/proxies/metrics"),
  metricsStreamURL: () => buildURLFromAPI("/proxies/metrics/stream"),
  // Failover-group membership (the all-in-one path is create/update via group).
  members: (id: number) => api<{ members: Proxy[] }>("GET", `/proxies/${id}/members`),
  setMembers: (id: number, body: ProxyFailoverGroup) =>
    api<{ ok: boolean }>("PUT", `/proxies/${id}/members`, { body }),
}

// Network domains — connectivity source of truth (security-architecture.md §3).
export const domainService = {
  list: () =>
    api<{ domains: Domain[]; summary?: { total: number; kinds: string[] } }>("GET", "/domains"),
  create: (body: Partial<Domain>) => api<Domain>("POST", "/domains", { body }),
  update: (id: number, body: Partial<Domain>) => api<Domain>("PATCH", `/domains/${id}`, { body }),
  remove: (id: number) => api<void>("DELETE", `/domains/${id}`),
}

// Reverse-connect Gateway Agents — admin lifecycle (security-architecture.md §4).
export const agentService = {
  list: (domainId: number) =>
    api<{ agents: GatewayAgent[] }>("GET", `/domains/${domainId}/agents`),
  // agent面 status: listener enabled? install-script path? binary staged?
  info: () => api<AgentGatewayInfo>("GET", "/agent-gateway/info"),
  generateToken: (domainId: number, body?: { allowed_cidr?: string; ttl_minutes?: number }) =>
    api<AgentEnrollToken>("POST", `/domains/${domainId}/agents/enroll-token`, { body: body ?? {} }),
  activate: (agentId: number) => api<{ ok: boolean }>("POST", `/agents/${agentId}/activate`),
  revoke: (agentId: number) => api<{ ok: boolean }>("POST", `/agents/${agentId}/revoke`),
  remove: (agentId: number) => api<void>("DELETE", `/agents/${agentId}`),
}

// Internal PKI — CA metadata + issued-certificate ledger (security-architecture.md §6).
export const pkiService = {
  ca: () => api<PKICAInfo>("GET", "/pki/ca"),
  certificates: (subjectKind?: string) =>
    api<{ certificates: PKICertificate[] }>("GET", "/pki/certificates", {
      query: subjectKind ? { subject_kind: subjectKind } : undefined,
    }),
  revoke: (serial: string) =>
    api<{ ok: boolean }>("POST", `/pki/certificates/${encodeURIComponent(serial)}/revoke`),
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
  create: (body: CredentialInput) => api<{ id: number }>("POST", "/credentials", { body }),
  update: (id: number, body: Partial<CredentialInput>) =>
    api<{ id: number }>("PATCH", `/credentials/${id}`, { body }),
  // `force` deletes even when nodes/proxies still reference the credential;
  // without it the server replies 409 with the referencing resources.
  remove: (id: number, opts: { force?: boolean } = {}) =>
    api<void>("DELETE", `/credentials/${id}`, { query: opts.force ? { force: "true" } : undefined }),
  usage: (id: number) => api<CredentialUsage>("GET", `/credentials/${id}/usage`),
  test: (id: number, body: { node_id?: number; host?: string; port?: number }) =>
    api<CredentialTestResult>("POST", `/credentials/${id}/test`, { body }),
}

// ----- role-aware dashboard -----
export const dashboardService = {
  summary: () => api<DashboardSummary>("GET", "/dashboard"),
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

// ----- Phase 12 — SSH power -----
export const sshKeyService = {
  list: () => api<{ keys: SSHKey[] }>("GET", "/me/ssh-keys"),
  create: (body: {
    name: string
    type?: string
    private?: string
    passphrase?: string
  }) =>
    api<{ key: SSHKey; private_pem_one_time?: string }>("POST", "/me/ssh-keys", { body }),
  update: (id: number, body: { name?: string }) =>
    api<SSHKey>("PATCH", `/me/ssh-keys/${id}`, { body }),
  remove: (id: number) => api<void>("DELETE", `/me/ssh-keys/${id}`),
}

export const knownHostService = {
  list: () => api<{ hosts: KnownHost[] }>("GET", "/me/known-hosts"),
  create: (body: Partial<KnownHost>) =>
    api<KnownHost>("POST", "/me/known-hosts", { body }),
  update: (id: number, body: Partial<KnownHost>) =>
    api<KnownHost>("PATCH", `/me/known-hosts/${id}`, { body }),
  remove: (id: number) => api<void>("DELETE", `/me/known-hosts/${id}`),
}

export const bulkRunService = {
  list: (limit = 50) =>
    api<{ runs: BulkRun[] }>("GET", "/me/bulk-runs", { query: { limit } }),
  get: (id: number) =>
    api<{ run: BulkRun; results: BulkRunResult[] }>("GET", `/me/bulk-runs/${id}`),
  run: (body: {
    title?: string
    command: string
    node_ids: number[]
    parallel?: number
    timeout_seconds?: number
  }) =>
    api<{ run: BulkRun; results: BulkRunResult[] }>("POST", "/me/bulk-runs", { body }),
  remove: (id: number) => api<void>("DELETE", `/me/bulk-runs/${id}`),
}

// ----- sessions / port-forwards / sftp -----
export const sessionService = {
  list: (
    opts: {
      status?: string
      kind?: string
      q?: string
      node_id?: number
      from?: string
      to?: string
      limit?: number
      offset?: number
    } = {},
  ) => api<{ sessions: Session[]; total: number }>("GET", "/sessions", { query: opts }),
  get: (id: string) => api<{ session: Session }>("GET", `/sessions/${id}`),
  audit: (id: string, limit = 500) =>
    api<{ events: AuditEvent[] }>("GET", `/sessions/${id}/audit`, { query: { limit } }),
  stats: (days = 14) => api<SessionStats>("GET", "/sessions/stats", { query: { days } }),
  terminate: (id: string) =>
    api<{ ok: boolean; live: boolean }>("POST", `/sessions/${id}/terminate`),
  recordingURL: (id: string) => withTokenQuery(`/api/proxy/api/v1/sessions/${id}/recording`),
  // Lifecycle v3 — connection-stage timeline, quality samples, and the bundled
  // one-shot lifecycle fetch for the detail dashboard.
  phases: (id: string) =>
    api<{ phases: SessionPhase[] }>("GET", `/sessions/${id}/phases`),
  metrics: (id: string, opts: { from?: string; to?: string; limit?: number } = {}) =>
    api<{ samples: SessionMetricSample[] }>("GET", `/sessions/${id}/metrics`, { query: opts }),
  lifecycle: (id: string) =>
    api<SessionLifecycle>("GET", `/sessions/${id}/lifecycle`),
  // Read-only live monitoring WS (over-the-shoulder). The browser opens these
  // directly; the token rides the query string like recordingURL.
  observeTerminalURL: (id: string) =>
    withTokenQuery(`/api/proxy/api/v1/ws/observe/terminal/${id}`),
  observeDesktopURL: (id: string) =>
    withTokenQuery(`/api/proxy/api/v1/ws/observe/desktop/${id}`),
}

// auditService backs the global audit center. `list`/`stats` go through the
// JSON client; `streamURL` feeds the SSE tail (token rides the Authorization
// header that streamSSE sets); `exportURL` is consumed by an <a download> so
// the token is appended as a query param.
function auditParams(q: AuditQuery): Record<string, string | number | undefined> {
  return {
    category: q.category || undefined,
    kind: q.kind || undefined,
    user_id: q.user_id,
    username: q.username || undefined,
    session_id: q.session_id || undefined,
    node_id: q.node_id,
    node_name: q.node_name || undefined,
    client_ip: q.client_ip || undefined,
    q: q.q || undefined,
    only_abnormal: q.only_abnormal ? 1 : undefined,
    from: q.from,
    to: q.to,
    limit: q.limit,
    offset: q.offset,
  }
}

export const auditService = {
  list: (q: AuditQuery = {}) =>
    api<{ audit_logs: AuditLogRow[]; total: number }>("GET", "/audit-logs", { query: auditParams(q) }),
  stats: (days = 14) => api<AuditStats>("GET", "/audit-logs/stats", { query: { days } }),
  streamURL: (q: AuditQuery = {}) => buildURLFromAPI("/audit-logs/stream", auditParams(q)),
  exportURL: (q: AuditQuery = {}) => withTokenQuery(buildURLFromAPI("/audit-logs/export", auditParams(q))),
  // M4 — tamper-evidence integrity report (hash-chain verify + signed checkpoints).
  integrity: () => api<AuditIntegrityReport>("GET", "/audit-logs/integrity"),
}

// ----- desktop per-user file drive (redirected into RDP sessions) -----
export const desktopDriveService = {
  info: () => api<DriveInfo>("GET", "/desktop/drive"),
  list: (path = "") =>
    api<{ entries: DriveEntry[] }>("GET", "/desktop/drive/list", { query: { path } }),
  upload: (
    file: File,
    path = "",
    onProgress?: (sent: number, total: number) => void,
    signal?: AbortSignal,
  ) =>
    apiUpload<{ ok: boolean; saved: number }>("/desktop/drive/upload", file, {
      query: { path },
      onProgress,
      signal,
    }),
  downloadURL: (path: string) =>
    withTokenQuery(`/api/proxy/api/v1/desktop/drive/download?path=${encodeURIComponent(path)}`),
  remove: (path: string) => api<{ ok: boolean }>("DELETE", "/desktop/drive", { query: { path } }),
  mkdir: (path: string) => api<{ ok: boolean }>("POST", "/desktop/drive/mkdir", { body: { path } }),
  // Rename or move within the drive. `to` is the full destination path
  // (parent dir + final name), so it covers both an in-place rename and a
  // move into another folder.
  rename: (from: string, to: string) =>
    api<{ ok: boolean }>("POST", "/desktop/drive/rename", { body: { from, to } }),
}

// ----- Workspace v2 — firewall + docker services -----

const fwBase = (nodeId: number) => `/nodes/${nodeId}/firewall`

export const firewallService = {
  status: (nodeId: number) => api<FirewallStatus>("GET", `${fwBase(nodeId)}/status`),
  listRules: (nodeId: number) => api<{ rules: FirewallRule[] }>("GET", `${fwBase(nodeId)}/rules`),
  diagnose: (nodeId: number) => api<FirewallDiagnostics>("GET", `${fwBase(nodeId)}/diagnose`),
  probe: (nodeId: number) => api<FirewallProbe>("GET", `${fwBase(nodeId)}/install/probe`),
  exposure: (nodeId: number) => api<{ ports: ExposurePort[] }>("GET", `${fwBase(nodeId)}/exposure`),
  presets: (nodeId: number) => api<{ presets: ServicePreset[] }>("GET", `${fwBase(nodeId)}/presets`),
  templates: (nodeId: number) => api<{ templates: PolicyTemplate[] }>("GET", `${fwBase(nodeId)}/templates`),
  // rules
  addRule: (nodeId: number, spec: FirewallRuleSpec) =>
    api<{ ok: boolean }>("POST", `${fwBase(nodeId)}/rules`, { body: spec }),
  deleteRule: (nodeId: number, index: number) =>
    api<{ ok: boolean }>("DELETE", `${fwBase(nodeId)}/rules/${index}`),
  insertRule: (nodeId: number, body: FirewallRuleInsert) =>
    api<{ ok: boolean }>("POST", `${fwBase(nodeId)}/rules/insert`, { body }),
  editRule: (nodeId: number, index: number, body: FirewallRuleEdit) =>
    api<{ ok: boolean }>("PUT", `${fwBase(nodeId)}/rules/${index}`, { body }),
  moveRule: (nodeId: number, body: FirewallRuleMove) =>
    api<{ ok: boolean }>("POST", `${fwBase(nodeId)}/rules/move`, { body }),
  bulkDelete: (nodeId: number, indexes: number[]) =>
    api<{ ok: boolean; deleted: number }>("POST", `${fwBase(nodeId)}/rules/bulk-delete`, { body: { indexes } }),
  persist: (nodeId: number) => api<{ ok: boolean }>("POST", `${fwBase(nodeId)}/persist`),
  enable: (nodeId: number) => api<{ ok: boolean }>("POST", `${fwBase(nodeId)}/enable`),
  disable: (nodeId: number) => api<{ ok: boolean }>("POST", `${fwBase(nodeId)}/disable`),
  // safe apply + rollback
  apply: (nodeId: number, req: FirewallApplyRequest) =>
    api<FirewallArmResult>("POST", `${fwBase(nodeId)}/apply`, { body: req }),
  commit: (nodeId: number, armToken: string) =>
    api<{ ok: boolean }>("POST", `${fwBase(nodeId)}/commit`, { body: { arm_token: armToken } }),
  rollback: (nodeId: number, armToken: string) =>
    api<{ ok: boolean }>("POST", `${fwBase(nodeId)}/rollback`, { body: { arm_token: armToken } }),
  // import / export
  export: (nodeId: number) => api<FirewallRulesetDump>("GET", `${fwBase(nodeId)}/export`),
  importPreview: (nodeId: number, content: string) =>
    api<FirewallApplyPlan>("POST", `${fwBase(nodeId)}/import/preview`, { body: { content } }),
  // fail2ban
  fail2ban: (nodeId: number) => api<Fail2banStatus>("GET", `${fwBase(nodeId)}/fail2ban`),
  fail2banBan: (nodeId: number, jail: string, ip: string) =>
    api<{ ok: boolean }>("POST", `${fwBase(nodeId)}/fail2ban/ban`, { body: { jail, ip } }),
  fail2banUnban: (nodeId: number, jail: string, ip: string) =>
    api<{ ok: boolean }>("POST", `${fwBase(nodeId)}/fail2ban/unban`, { body: { jail, ip } }),
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
  pause: (nodeId: number, cid: string) =>
    api<{ ok: boolean }>("POST", `/nodes/${nodeId}/docker/containers/${cid}/pause`),
  unpause: (nodeId: number, cid: string) =>
    api<{ ok: boolean }>("POST", `/nodes/${nodeId}/docker/containers/${cid}/unpause`),
  kill: (nodeId: number, cid: string) =>
    api<{ ok: boolean }>("POST", `/nodes/${nodeId}/docker/containers/${cid}/kill`),
  rename: (nodeId: number, cid: string, name: string) =>
    api<{ ok: boolean }>("POST", `/nodes/${nodeId}/docker/containers/${cid}/rename`, { body: { name } }),
  inspect: (nodeId: number, cid: string) =>
    api<DockerContainerDetail>("GET", `/nodes/${nodeId}/docker/containers/${cid}/inspect`),
  top: (nodeId: number, cid: string) =>
    api<DockerTop>("GET", `/nodes/${nodeId}/docker/containers/${cid}/top`),
  stats: (nodeId: number) =>
    api<{ stats: DockerStats[] }>("GET", `/nodes/${nodeId}/docker/stats`),
  networks: (nodeId: number) =>
    api<{ networks: DockerNetwork[] }>("GET", `/nodes/${nodeId}/docker/networks`),
  volumes: (nodeId: number) =>
    api<{ volumes: DockerVolume[] }>("GET", `/nodes/${nodeId}/docker/volumes`),
  pullImage: (nodeId: number, ref: string) =>
    api<DockerActionResult>("POST", `/nodes/${nodeId}/docker/images/pull`, { body: { ref } }),
  removeImage: (nodeId: number, ref: string, force = false) =>
    api<DockerActionResult>("POST", `/nodes/${nodeId}/docker/images/remove`, { body: { ref, force } }),
  prune: (nodeId: number, what: string) =>
    api<DockerActionResult>("POST", `/nodes/${nodeId}/docker/prune`, { body: { what } }),
}

export const systemdService = {
  status: (nodeId: number) =>
    api<SystemdStatus>("GET", `/nodes/${nodeId}/systemd/status`),
  listUnits: (nodeId: number, filter = "") =>
    api<{ units: SystemdUnit[] }>("GET", `/nodes/${nodeId}/systemd/units`, {
      query: filter ? { filter } : undefined,
    }),
  detail: (nodeId: number, name: string, lines = 200) =>
    api<SystemdDetail>("GET", `/nodes/${nodeId}/systemd/unit`, {
      query: { name, lines },
    }),
  journal: (nodeId: number, name: string, lines = 300) =>
    api<SystemdJournal>("GET", `/nodes/${nodeId}/systemd/journal`, {
      query: { name, lines },
    }),
  action: (nodeId: number, name: string, verb: SystemdVerb) =>
    api<{ ok: boolean }>("POST", `/nodes/${nodeId}/systemd/action`, {
      body: { name, verb },
    }),
}

export const processService = {
  list: (nodeId: number, sort: ProcSort = "cpu") =>
    api<ProcList>("GET", `/nodes/${nodeId}/process/list`, { query: { sort } }),
  detail: (nodeId: number, pid: number) =>
    api<ProcDetail>("GET", `/nodes/${nodeId}/process/detail`, { query: { pid } }),
  signal: (nodeId: number, pid: number, signal: ProcSignal) =>
    api<{ ok: boolean }>("POST", `/nodes/${nodeId}/process/signal`, { body: { pid, signal } }),
  renice: (nodeId: number, pid: number, nice: number) =>
    api<{ ok: boolean }>("POST", `/nodes/${nodeId}/process/renice`, { body: { pid, nice } }),
}

export const perfService = {
  snapshot: (nodeId: number) =>
    api<PerfSnapshot>("GET", `/nodes/${nodeId}/perf/snapshot`),
  dmesg: (nodeId: number, lines = 200) =>
    api<PerfDmesg>("GET", `/nodes/${nodeId}/perf/dmesg`, { query: { lines } }),
}

export const logsService = {
  files: (nodeId: number) => api<LogList>("GET", `/nodes/${nodeId}/logs/files`),
  tail: (nodeId: number, source: "journal" | "file", ref: string, lines = 200) =>
    api<LogTail>("GET", `/nodes/${nodeId}/logs/tail`, { query: { source, ref, lines } }),
  // SSE follow URL — consumed by EventSource, which can't set headers, so the
  // access token rides as a query param (backend middleware honours ?token=).
  followURL: (nodeId: number, source: "journal" | "file", ref: string, lines = 200) =>
    withTokenQuery(buildURLFromAPI(`/nodes/${nodeId}/logs/follow`, { source, ref, lines })),
}

export const hardwareService = {
  info: (nodeId: number) => api<Hardware>("GET", `/nodes/${nodeId}/hardware`),
}

export const kernelService = {
  info: (nodeId: number) => api<KernelInfo>("GET", `/nodes/${nodeId}/kernel`),
  setSysctl: (nodeId: number, key: string, value: string, persist: boolean) =>
    api<{ ok: boolean }>("POST", `/nodes/${nodeId}/kernel/sysctl`, { body: { key, value, persist } }),
}

export const storageService = {
  info: (nodeId: number) => api<StorageInfo>("GET", `/nodes/${nodeId}/storage`),
  mount: (nodeId: number, target: string) =>
    api<{ ok: boolean }>("POST", `/nodes/${nodeId}/storage/mount`, { body: { target } }),
  unmount: (nodeId: number, target: string) =>
    api<{ ok: boolean }>("POST", `/nodes/${nodeId}/storage/umount`, { body: { target } }),
}

export const networkService = {
  info: (nodeId: number) => api<NetInfo>("GET", `/nodes/${nodeId}/network`),
  diagnose: (nodeId: number, tool: NetDiagTool, target: string) =>
    api<NetDiagResult>("POST", `/nodes/${nodeId}/network/diagnose`, { body: { tool, target } }),
  setIface: (nodeId: number, name: string, up: boolean) =>
    api<{ ok: boolean }>("POST", `/nodes/${nodeId}/network/iface`, { body: { name, up } }),
}

export type WGPeer = {
  public_key: string
  endpoint: string
  allowed_ips: string[] | null
  latest_handshake: number
  transfer_rx: number
  transfer_tx: number
  keepalive: string
}
export type WGIface = {
  name: string
  public_key: string
  listen_port: number
  peers: WGPeer[] | null
  // Enriched metadata from the conf + systemctl (optional / back-compatible).
  addresses?: string[] | null
  mtu?: number
  dns?: string[] | null
  up: boolean
  autostart: boolean
  has_conf: boolean
}
export type WGStatus = {
  available: boolean
  reason?: string
  installed: boolean
  kernel_module: boolean
  ifaces: WGIface[] | null
  sampled_at: string
}
export type WGProbe = {
  os_id: string
  pkg_manager: string
  installed: boolean
  wg_quick: boolean
  kernel_module: string
  can_sudo: boolean
  kernel: string
  cmd_preview: string
  sampled_at: string
}
export type WGKeyPair = { private_key: string; public_key: string }
export type WGPeerConfig = {
  public_key: string
  preshared_key?: string
  allowed_ips: string[] | null
  endpoint?: string
  persistent_keepalive?: number
  comment?: string
}
export type WGIfaceConfig = {
  name: string
  private_key?: string
  public_key?: string
  address: string[] | null
  listen_port?: number
  dns?: string[] | null
  mtu?: number
  pre_up?: string[] | null
  post_up?: string[] | null
  pre_down?: string[] | null
  post_down?: string[] | null
  save_config?: boolean
  peers: WGPeerConfig[] | null
  /** Non-fatal note from create (e.g. conf written but wg-quick up failed). */
  warning?: string
}
export type WGConf = {
  name: string
  path: string
  content: string
  exists: boolean
  sha256?: string
  sampled_at: string
}
export type WGConfDiff = { name: string; original: string; modified: string; changed: boolean }
export type WGGatewayStatus = {
  ip_forward: boolean
  ip_forward_persisted: boolean
  nat_enabled: boolean
  egress_iface: string
  egress_candidates: string[] | null
  rules: string[] | null
  sampled_at: string
}
export type WGClientConfig = {
  interface_name: string
  address: string
  public_key: string
  server_public_key: string
  endpoint: string
  dns?: string
  allowed_ips: string
  persistent_keepalive?: number
  conf: string
}
export type WGCreateIfaceReq = {
  name: string
  address: string[]
  listen_port?: number
  dns?: string[]
  mtu?: number
  private_key?: string
  save_config?: boolean
  enable_nat?: boolean
  nat_egress?: string
  autostart?: boolean
  bring_up?: boolean
}
export type WGUpdateIfaceReq = {
  address?: string[]
  listen_port?: number
  dns?: string[]
  mtu?: number
  post_up?: string[]
  post_down?: string[]
}
export type WGPeerReq = {
  public_key: string
  allowed_ips: string[]
  endpoint?: string
  persistent_keepalive?: number
  preshared_key?: string
  comment?: string
}
export type WGClientReq = {
  comment?: string
  dns?: string[]
  allowed_ips?: string[]
  endpoint?: string
  persistent_keepalive?: number
  use_psk?: boolean
}

const wgIfacePath = (nodeId: number, name: string) =>
  `/nodes/${nodeId}/wireguard/ifaces/${encodeURIComponent(name)}`

export const wireguardService = {
  status: (nodeId: number) => api<WGStatus>("GET", `/nodes/${nodeId}/wireguard`),
  probe: (nodeId: number) => api<WGProbe>("GET", `/nodes/${nodeId}/wireguard/probe`),
  setIface: (nodeId: number, name: string, up: boolean) =>
    api<{ ok: boolean }>("POST", `/nodes/${nodeId}/wireguard/iface`, { body: { name, up } }),
  // keys
  genKeys: (nodeId: number) => api<WGKeyPair>("POST", `/nodes/${nodeId}/wireguard/keys`),
  genPSK: (nodeId: number) =>
    api<{ preshared_key: string }>("POST", `/nodes/${nodeId}/wireguard/psk`),
  // interfaces
  getIface: (nodeId: number, name: string) => api<WGIfaceConfig>("GET", wgIfacePath(nodeId, name)),
  createIface: (nodeId: number, body: WGCreateIfaceReq) =>
    api<WGIfaceConfig>("POST", `/nodes/${nodeId}/wireguard/ifaces`, { body }),
  updateIface: (nodeId: number, name: string, body: WGUpdateIfaceReq) =>
    api<WGIfaceConfig>("PATCH", wgIfacePath(nodeId, name), { body }),
  deleteIface: (nodeId: number, name: string, confirm: boolean) =>
    api<{ ok: boolean }>("DELETE", wgIfacePath(nodeId, name), { body: { confirm } }),
  setAutostart: (nodeId: number, name: string, enabled: boolean) =>
    api<{ ok: boolean }>("POST", `${wgIfacePath(nodeId, name)}/autostart`, { body: { enabled } }),
  // config file
  readConf: (nodeId: number, name: string) => api<WGConf>("GET", `${wgIfacePath(nodeId, name)}/conf`),
  writeConf: (nodeId: number, name: string, content: string, expectSha?: string) =>
    api<{ ok: boolean }>("PUT", `${wgIfacePath(nodeId, name)}/conf`, {
      body: { content, expect_sha: expectSha },
    }),
  diffConf: (nodeId: number, name: string, content: string) =>
    api<WGConfDiff>("POST", `${wgIfacePath(nodeId, name)}/conf/diff`, { body: { content } }),
  // peers
  addPeer: (nodeId: number, name: string, body: WGPeerReq) =>
    api<{ ok: boolean }>("POST", `${wgIfacePath(nodeId, name)}/peers`, { body }),
  updatePeer: (nodeId: number, name: string, body: WGPeerReq) =>
    api<{ ok: boolean }>("POST", `${wgIfacePath(nodeId, name)}/peers/update`, { body }),
  deletePeer: (nodeId: number, name: string, publicKey: string) =>
    api<{ ok: boolean }>("POST", `${wgIfacePath(nodeId, name)}/peers/delete`, {
      body: { public_key: publicKey },
    }),
  // clients
  newClient: (nodeId: number, name: string, body: WGClientReq) =>
    api<WGClientConfig>("POST", `${wgIfacePath(nodeId, name)}/clients`, { body }),
  // gateway
  gateway: (nodeId: number) => api<WGGatewayStatus>("GET", `/nodes/${nodeId}/wireguard/gateway`),
  setForwarding: (nodeId: number, persist: boolean) =>
    api<{ ok: boolean }>("POST", `/nodes/${nodeId}/wireguard/gateway/forwarding`, { body: { persist } }),
  setNat: (nodeId: number, enabled: boolean, egress: string, confirm: boolean) =>
    api<{ ok: boolean }>("POST", `/nodes/${nodeId}/wireguard/gateway/nat`, {
      body: { enabled, egress, confirm },
    }),
}

export type FileEntry = {
  name: string
  type: "dir" | "file" | "link" | "other"
  size: number
  mode: string
  mtime: number
  owner: string
}
export type FileListing = { path: string; entries: FileEntry[] | null }
export type FileContent = {
  path: string
  content: string
  size: number
  truncated: boolean
  binary: boolean
}
export const filesService = {
  list: (nodeId: number, path: string) =>
    api<FileListing>("GET", `/nodes/${nodeId}/files/list`, { query: { path } }),
  read: (nodeId: number, path: string) =>
    api<FileContent>("GET", `/nodes/${nodeId}/files/read`, { query: { path } }),
  write: (nodeId: number, path: string, content: string) =>
    api<{ ok: boolean }>("POST", `/nodes/${nodeId}/files/write`, { body: { path, content } }),
  chmod: (nodeId: number, path: string, mode: string) =>
    api<{ ok: boolean }>("POST", `/nodes/${nodeId}/files/chmod`, { body: { path, mode } }),
}

export type LogLevel = "error" | "warn" | "info" | "other"
export type LogMatch = { source: string; line: number; text: string; level: LogLevel }
export type LogLevels = { error: number; warn: number; info: number; other: number }
export type LogSearchResult = {
  matches: LogMatch[] | null
  levels: LogLevels
  truncated: boolean
  sampled_at: string
}
export type LogSearchQuery = {
  source: "files" | "journal"
  pattern: string
  path?: string
  unit?: string
  lines?: number
}
export const logAnalyticsService = {
  search: (nodeId: number, q: LogSearchQuery) =>
    api<LogSearchResult>("POST", `/nodes/${nodeId}/loganalytics/search`, { body: q }),
}

export type BackupTools = { rsync: boolean; tar: boolean; restic: boolean; at: boolean }
export type AtJob = { id: string; when: string; user: string }
export type BackupInfo = { tools: BackupTools; at_jobs: AtJob[] | null; sampled_at: string }
export const backupService = {
  info: (nodeId: number) => api<BackupInfo>("GET", `/nodes/${nodeId}/backup`),
  snapshot: (nodeId: number, method: "tar" | "rsync", src: string, dest: string) =>
    api<{ output: string }>("POST", `/nodes/${nodeId}/backup/snapshot`, { body: { method, src, dest } }),
  addAt: (nodeId: number, when: string, command: string) =>
    api<{ ok: boolean }>("POST", `/nodes/${nodeId}/backup/at`, { body: { when, command } }),
  removeAt: (nodeId: number, id: string) =>
    api<{ ok: boolean }>("POST", `/nodes/${nodeId}/backup/at/remove`, { body: { id } }),
}

export type CaptureInterfaces = { has_tcpdump: boolean; ifaces: string[] | null }
export type CaptureResult = { lines: string[] | null; count: number; sampled_at: string }
export type PcapResult = { filename: string; base64: string; bytes: number }
export type CaptureOpts = { iface: string; filter?: string; count?: number; seconds?: number }
export const captureService = {
  interfaces: (nodeId: number) => api<CaptureInterfaces>("GET", `/nodes/${nodeId}/capture/interfaces`),
  run: (nodeId: number, opts: CaptureOpts) =>
    api<CaptureResult>("POST", `/nodes/${nodeId}/capture/run`, { body: opts }),
  pcap: (nodeId: number, opts: CaptureOpts) =>
    api<PcapResult>("POST", `/nodes/${nodeId}/capture/pcap`, { body: opts }),
}

export const cronService = {
  info: (nodeId: number) => api<CronInfo>("GET", `/nodes/${nodeId}/cron`),
  add: (nodeId: number, entry: string) =>
    api<{ ok: boolean }>("POST", `/nodes/${nodeId}/cron/add`, { body: { entry } }),
  remove: (nodeId: number, index: number) =>
    api<{ ok: boolean }>("POST", `/nodes/${nodeId}/cron/remove`, { body: { index } }),
  setTimer: (nodeId: number, unit: string, enable: boolean) =>
    api<{ ok: boolean }>("POST", `/nodes/${nodeId}/cron/timer`, { body: { unit, enable } }),
}

export const packageService = {
  status: (nodeId: number) => api<PkgStatus>("GET", `/nodes/${nodeId}/packages/status`),
  upgradable: (nodeId: number) =>
    api<{ updates: PkgUpdate[] }>("GET", `/nodes/${nodeId}/packages/upgradable`),
  search: (nodeId: number, q: string) =>
    api<{ packages: PkgSearchItem[] }>("GET", `/nodes/${nodeId}/packages/search`, { query: { q } }),
  action: (nodeId: number, verb: PkgVerb, name?: string) =>
    api<PkgActionResult>("POST", `/nodes/${nodeId}/packages/action`, { body: { verb, name } }),
  info: (nodeId: number, name: string) =>
    api<PkgInfo>("GET", `/nodes/${nodeId}/packages/info`, { query: { name } }),
  installed: (nodeId: number, q = "") =>
    api<{ packages: PkgSearchItem[] }>("GET", `/nodes/${nodeId}/packages/installed`, { query: q ? { q } : undefined }),
  files: (nodeId: number, name: string) =>
    api<{ files: string[] }>("GET", `/nodes/${nodeId}/packages/files`, { query: { name } }),
  history: (nodeId: number) =>
    api<{ lines: string[] }>("GET", `/nodes/${nodeId}/packages/history`),
  hold: (nodeId: number, name: string, hold: boolean) =>
    api<{ ok: boolean }>("POST", `/nodes/${nodeId}/packages/hold`, { body: { name, hold } }),
}

export const usersService = {
  info: (nodeId: number) => api<SysUserInfo>("GET", `/nodes/${nodeId}/users`),
  lock: (nodeId: number, user: string, lock: boolean) =>
    api<{ ok: boolean }>("POST", `/nodes/${nodeId}/users/lock`, { body: { user, lock } }),
  addToGroup: (nodeId: number, user: string, group: string) =>
    api<{ ok: boolean }>("POST", `/nodes/${nodeId}/users/group`, { body: { user, group } }),
}

export const securityService = {
  report: (nodeId: number) => api<SecReport>("GET", `/nodes/${nodeId}/security`),
  apply: (nodeId: number, check: string) =>
    api<{ ok: boolean; output: string }>("POST", `/nodes/${nodeId}/security/apply`, { body: { check } }),
}

export const portfwdService = {
  list: () => api<{ port_forwards: PortForward[] }>("GET", "/portforward"),
  create: (input: {
    node_id: number
    ttl?: string
    label?: string
    tags?: string[]
    pinned?: boolean
  }) => api<PortForward>("POST", "/portforward", { body: input }),
  update: (id: string, patch: { label?: string; tags?: string[]; pinned?: boolean }) =>
    api<PortForward>("PATCH", `/portforward/${id}`, { body: patch }),
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
export type SftpSearchHit = SftpEntry & {
  /** Directory the hit was found in (its parent), for "name — /etc/nginx" rows. */
  dir: string
}
export type SftpSearchResult = {
  root: string
  query: string
  entries: SftpSearchHit[]
  truncated: boolean
  scanned: number
}
// OnlyOffice editor bootstrap returned by the office-config endpoints; shared
// by the SFTP and OSS surfaces and consumed by the OfficeEditor viewer.
export type OfficeConfigResponse = {
  document_server_url: string
  config: Record<string, unknown> & { document?: { title?: string } }
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
  // Recursive name search under `path`, server-bounded by count / scan / time.
  search: (nodeId: number, path: string, q: string, limit?: number) =>
    api<SftpSearchResult>("GET", `/nodes/${nodeId}/sftp/search`, {
      query: { path, q, ...(limit ? { limit: String(limit) } : {}) },
    }),
  // Server-side duplicate of a file or directory tree (no client round-trip).
  copy: (nodeId: number, from: string, to: string) =>
    api<{ ok: boolean; from: string; to: string; bytes: number }>("POST", `/nodes/${nodeId}/sftp/copy`, {
      body: { from, to },
    }),
  // Streamed tar.gz of one or more paths; returns a tokenized browser URL.
  archiveURL: (nodeId: number, paths: string[]) =>
    withTokenQuery(
      `/api/proxy/api/v1/nodes/${nodeId}/sftp/archive?${paths
        .map((p) => `paths=${encodeURIComponent(p)}`)
        .join("&")}`,
    ),
  // OnlyOffice editor config for an Office document on this node.
  officeConfig: (nodeId: number, path: string) =>
    api<OfficeConfigResponse>("GET", `/nodes/${nodeId}/sftp/office/config`, { query: { path } }),
}

// ----- OSS object storage (bastion) -----
export const ossService = {
  buckets: (nodeId: number) =>
    api<{ provider: OssProvider; region?: string; default_bucket?: string; buckets: OssBucket[] | null }>(
      "GET",
      `/nodes/${nodeId}/oss/buckets`,
    ),
  objects: (nodeId: number, bucket: string, prefix = "", token = "") =>
    api<OssListResult>("GET", `/nodes/${nodeId}/oss/objects`, {
      query: { bucket, prefix, ...(token ? { token } : {}) },
    }),
  stat: (nodeId: number, bucket: string, key: string) =>
    api<OssObjectMeta>("GET", `/nodes/${nodeId}/oss/stat`, { query: { bucket, key } }),
  preview: (nodeId: number, bucket: string, key: string) =>
    api<{ key: string; size: number; content: string; truncated: boolean; binary?: boolean }>(
      "GET",
      `/nodes/${nodeId}/oss/preview`,
      { query: { bucket, key } },
    ),
  stats: (nodeId: number, bucket: string, prefix = "") =>
    api<OssStats>("GET", `/nodes/${nodeId}/oss/stats`, {
      query: { bucket, ...(prefix ? { prefix } : {}) },
    }),
  mkdir: (nodeId: number, bucket: string, prefix: string) =>
    api<{ ok: boolean; bucket: string; key: string }>("POST", `/nodes/${nodeId}/oss/mkdir`, {
      body: { bucket, prefix },
    }),
  remove: (nodeId: number, bucket: string, key: string, recursive = false) =>
    api<{ ok: boolean; deleted: number }>("DELETE", `/nodes/${nodeId}/oss/object`, {
      query: { bucket, key, ...(recursive ? { recursive: "true" } : {}) },
    }),
  copy: (
    nodeId: number,
    body: { bucket: string; src: string; dst: string; dst_bucket?: string; move?: boolean },
  ) =>
    api<{ ok: boolean; copied: number; move: boolean }>("POST", `/nodes/${nodeId}/oss/copy`, { body }),
  upload: (
    nodeId: number,
    bucket: string,
    prefix: string,
    file: File | Blob,
    opts: { name?: string; onProgress?: UploadOptions["onProgress"]; signal?: AbortSignal } = {},
  ) =>
    apiUpload<{ ok: boolean; bucket: string; key: string; bytes: number }>(
      `/nodes/${nodeId}/oss/upload`,
      file,
      {
        query: { bucket, prefix, ...(opts.name ? { name: opts.name } : {}) },
        onProgress: opts.onProgress,
        signal: opts.signal,
      },
    ),
  downloadURL: (nodeId: number, bucket: string, key: string) =>
    withTokenQuery(
      `/api/proxy/api/v1/nodes/${nodeId}/oss/download?bucket=${encodeURIComponent(bucket)}&key=${encodeURIComponent(key)}`,
    ),
  discover: (body: {
    provider: string
    endpoint?: string
    region?: string
    credential_id: number
    proxy_chain?: string
    insecure_tls?: boolean
    path_style?: boolean
  }) =>
    api<{ ok: boolean; provider: OssProvider; buckets: OssBucket[] | null }>("POST", `/oss/discover`, {
      body,
    }),
  // OnlyOffice editor config for an object.
  officeConfig: (nodeId: number, bucket: string, key: string) =>
    api<OfficeConfigResponse>("GET", `/nodes/${nodeId}/oss/office/config`, { query: { bucket, key } }),
}

// ----- users / roles / groups / departments (admin) -----
export const userService = {
  list: (
    opts: {
      search?: string
      disabled?: "true" | "false"
      status?: string
      department_id?: number
      role_id?: number
      tag_id?: number
      mfa?: "true" | "false"
      active_days?: number
      sort?: "username" | "created" | "login"
      order?: "asc" | "desc"
      limit?: number
      offset?: number
    } = {},
  ) => api<{ users: User[]; total: number }>("GET", "/users", { query: opts }),
  stats: (days = 14) => api<UserStats>("GET", "/users/stats", { query: { days } }),
  detail: (id: number) => api<UserDetail>("GET", `/users/${id}`),
  create: (body: Partial<User> & { password: string }) => api<User>("POST", "/users", { body }),
  update: (id: number, body: Partial<User>) => api<User>("PATCH", `/users/${id}`, { body }),
  remove: (id: number) => api<void>("DELETE", `/users/${id}`),
  bulk: (body: { ids: number[]; action: string; department_ids?: number[] }) =>
    api<{ ok: boolean; affected: number }>("POST", "/users/bulk", { body }),
  resetPassword: (id: number, password: string) => api<void>("POST", `/users/${id}/reset-password`, { body: { password } }),
  unlock: (id: number) => api<void>("POST", `/users/${id}/unlock`),
  forceLogout: (id: number) => api<void>("POST", `/users/${id}/force-logout`),
  listRoles: (id: number) => api<{ roles: Role[] }>("GET", `/users/${id}/roles`),
  replaceRoles: (id: number, role_ids: number[]) => api<void>("PUT", `/users/${id}/roles`, { body: { role_ids } }),
  setTags: (id: number, tag_ids: number[]) => api<void>("PUT", `/users/${id}/tags`, { body: { tag_ids } }),
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
  // Reparent (drag-and-drop / "move to…"); parent_id null = top level.
  move: (id: number, parent_id: number | null) =>
    api<Department>("PUT", `/departments/${id}/parent`, { body: { parent_id } }),
  remove: (id: number) => api<void>("DELETE", `/departments/${id}`),
  members: (id: number) => api<{ user_ids: number[] }>("GET", `/departments/${id}/members`),
  addMember: (id: number, user_id: number) => api<void>("POST", `/departments/${id}/members`, { body: { user_id } }),
  removeMember: (id: number, uid: number) => api<void>("DELETE", `/departments/${id}/members/${uid}`),
}

export const groupService = {
  list: () => api<{ groups: UserGroup[] }>("GET", "/groups"),
  create: (body: Partial<UserGroup>) => api<UserGroup>("POST", "/groups", { body }),
  update: (id: number, body: Partial<UserGroup>) => api<UserGroup>("PATCH", `/groups/${id}`, { body }),
  // Reparent (drag-and-drop / "move to…"); parent_id null = top level.
  move: (id: number, parent_id: number | null) =>
    api<UserGroup>("PUT", `/groups/${id}/parent`, { body: { parent_id } }),
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
  // Reparent (drag-and-drop / "move to…"); parent_id null = top level.
  move: (id: number, parent_id: number | null) =>
    api<AssetGroup>("PUT", `/asset-groups/${id}/parent`, { body: { parent_id } }),
  remove: (id: number) => api<void>("DELETE", `/asset-groups/${id}`),
  addNode: (id: number, node_id: number) => api<void>("POST", `/asset-groups/${id}/nodes`, { body: { node_id } }),
  removeNode: (id: number, nid: number) => api<void>("DELETE", `/asset-groups/${id}/nodes/${nid}`),
  // Bulk membership for the asset tree's batch bar / multi-node drag.
  addNodesBatch: (id: number, node_ids: number[]) =>
    api<BatchResult>("POST", `/asset-groups/${id}/nodes/batch`, { body: { node_ids } }),
  removeNodesBatch: (id: number, node_ids: number[]) =>
    api<BatchResult>("DELETE", `/asset-groups/${id}/nodes/batch`, { body: { node_ids } }),
}
export const tagService = {
  list: () => api<{ tags: AssetTag[]; groups: AssetTagGroup[] }>("GET", "/tags"),
  create: (body: Partial<AssetTag>) => api<AssetTag>("POST", "/tags", { body }),
  update: (id: number, body: Partial<AssetTag>) => api<AssetTag>("PATCH", `/tags/${id}`, { body }),
  remove: (id: number) => api<void>("DELETE", `/tags/${id}`),
  attach: (nodeId: number, tag_id: number) => api<void>("POST", `/nodes/${nodeId}/tags`, { body: { tag_id } }),
  detach: (nodeId: number, tagId: number) => api<void>("DELETE", `/nodes/${nodeId}/tags/${tagId}`),
  // Set a node's tags to exactly this set (the tag-picker save path).
  replaceNodeTags: (nodeId: number, tag_ids: number[]) =>
    api<void>("PUT", `/nodes/${nodeId}/tags`, { body: { tag_ids } }),
  // Bulk: put / pull one tag across many nodes (asset tree batch tag actions).
  attachBatch: (tagId: number, node_ids: number[]) =>
    api<BatchResult>("POST", `/tags/${tagId}/nodes/batch`, { body: { node_ids } }),
  detachBatch: (tagId: number, node_ids: number[]) =>
    api<BatchResult>("DELETE", `/tags/${tagId}/nodes/batch`, { body: { node_ids } }),
}
export const tagGroupService = {
  list: () => api<{ groups: AssetTagGroup[] }>("GET", "/tag-groups"),
  create: (body: Partial<AssetTagGroup>) => api<AssetTagGroup>("POST", "/tag-groups", { body }),
  update: (id: number, body: Partial<AssetTagGroup>) =>
    api<AssetTagGroup>("PATCH", `/tag-groups/${id}`, { body }),
  remove: (id: number) => api<void>("DELETE", `/tag-groups/${id}`),
}
export const grantService = {
  list: () => api<{ grants: AssetGrant[] }>("GET", "/asset-grants"),
  create: (body: Partial<AssetGrant>) => api<AssetGrant>("POST", "/asset-grants", { body }),
  remove: (id: number) => api<void>("DELETE", `/asset-grants/${id}`),
  // 授权向导：一次给「多个主体 × 多个资产」批量授权。
  createBatch: (body: {
    grantees: GranteeRef[]
    subjects: { type: SubjectKind; id: number }[]
    actions: string
    valid_from?: string
    valid_to?: string
  }) => api<{ created: number }>("POST", "/asset-grants/batch", { body }),
  // 按人看：穿透解析某主体实际可访问的资产 + 来源。
  byGrantee: (type: GranteeKind, id: number) =>
    api<AccessExplanation>("GET", `/access/by-grantee?type=${type}&id=${id}`),
  // 按资产看：某节点谁能访问、经由什么、何时到期。
  bySubject: (nodeId: number) =>
    api<{ grantees: SubjectAccessRow[] }>("GET", `/access/by-subject?node_id=${nodeId}`),
}

// ----- 授权目录 (per-object authorisation tree) -----
// Object-centric: pass the owner (user / group / department) on every write.
// Editing an object's tree IS authorising it (unified under grant:manage).
export const accessTreeService = {
  get: (owner_type: GranteeKind, owner_id: number) =>
    api<AccessTreeData>("GET", `/access-tree?owner_type=${owner_type}&owner_id=${owner_id}`),

  createFolder: (body: {
    owner_type: GranteeKind
    owner_id: number
    name: string
    parent_id?: number | null
    icon?: string
    actions?: string
    valid_from?: string
    valid_to?: string
  }) => api<AccessFolder>("POST", "/access-tree/folders", { body }),
  updateFolder: (
    id: number,
    body: { name?: string; icon?: string; actions?: string; valid_from?: string; valid_to?: string },
  ) => api<AccessFolder>("PATCH", `/access-tree/folders/${id}`, { body }),
  // Reparent (drag-and-drop / "move to…"); parent_id null = top level.
  moveFolder: (id: number, parent_id: number | null) =>
    api<void>("PUT", `/access-tree/folders/${id}/parent`, { body: { parent_id } }),
  removeFolder: (id: number) => api<void>("DELETE", `/access-tree/folders/${id}`),

  addItems: (body: {
    owner_type: GranteeKind
    owner_id: number
    folder_id: number
    node_ids: number[]
    actions?: string
    valid_from?: string
    valid_to?: string
  }) => api<{ added: number }>("POST", "/access-tree/items", { body }),
  // folder_id re-homes the item into another folder (drag between folders).
  updateItem: (
    id: number,
    body: { actions?: string; valid_from?: string; valid_to?: string; folder_id?: number },
  ) => api<AccessItem>("PATCH", `/access-tree/items/${id}`, { body }),
  removeItem: (id: number) => api<void>("DELETE", `/access-tree/items/${id}`),

  // push a folder's permission + validity down its whole subtree
  applySubtree: (id: number, body: { actions: string; valid_to: string }) =>
    api<void>("POST", `/access-tree/folders/${id}/apply-subtree`, { body }),
  // deep-copy one owner's / template's tree onto another object
  clone: (body: {
    from_owner_type: GranteeKind | "template"
    from_owner_id: number
    to_owner_type: GranteeKind | "template"
    to_owner_id: number
  }) => api<void>("POST", "/access-tree/clone", { body }),
  // persist drag-reordering of siblings
  reorder: (kind: "folder" | "item", ids: number[]) =>
    api<void>("POST", "/access-tree/reorder", { body: { kind, ids } }),

  listTemplates: () => api<{ templates: AccessTemplate[] }>("GET", "/access-templates"),
  createTemplate: (body: { name: string; description?: string; from_owner_type?: GranteeKind; from_owner_id?: number }) =>
    api<AccessTemplate>("POST", "/access-templates", { body }),
  removeTemplate: (id: number) => api<void>("DELETE", `/access-templates/${id}`),
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
export interface ProviderTestResult {
  ok: boolean
  reachable?: boolean
  latency_ms?: number
  model_count?: number
  sample_model?: string
  error?: string
}

export const aiProviderService = {
  list: () => api<{ providers: AIProvider[] }>("GET", "/ai/providers"),
  create: (
    body: Partial<Omit<AIProvider, "extra">> & {
      api_key: string
      models?: AIModel[]
      extra?: Record<string, unknown>
    },
  ) => api<{ id: number }>("POST", "/ai/providers", { body }),
  update: (
    id: number,
    body: Partial<Omit<AIProvider, "extra">> & {
      api_key?: string
      models?: AIModel[]
      extra?: Record<string, unknown>
    },
  ) => api<{ id: number }>("PATCH", `/ai/providers/${id}`, { body }),
  remove: (id: number) => api<void>("DELETE", `/ai/providers/${id}`),
  // Richer than the old { ok }: latency + a bounded model probe.
  test: (id: number) => api<ProviderTestResult>("POST", `/ai/providers/${id}/test`),
  // Pre-create probe (wizard step 3) — test an unsaved draft.
  testDraft: (body: {
    kind: ProviderKind
    name?: string
    base_url?: string
    api_key: string
    proxy_url?: string
    extra?: Record<string, unknown>
  }) => api<ProviderTestResult>("POST", "/ai/provider-test", { body }),
  // Live model discovery for an unsaved draft (wizard step 4).
  discoverModels: (body: {
    kind: ProviderKind
    base_url?: string
    api_key: string
    proxy_url?: string
    extra?: Record<string, unknown>
  }) => api<{ models: AIModel[]; discovery_supported?: boolean; error?: string }>("POST", "/ai/provider-discover-models", { body }),
  // Live models. merge=1 unions live discovery + preset catalog + curated list.
  models: (id: number, merge = false) =>
    api<{ models: AIModel[] }>("GET", `/ai/providers/${id}/models`, merge ? { query: { merge: 1 } } : {}),
  // Persist the curated model set (capabilities + pricing) + default model.
  saveModels: (id: number, body: { models: AIModel[]; default_model?: string }) =>
    api<{ ok: boolean }>("PUT", `/ai/providers/${id}/models`, { body }),
  // The static provider catalog driving the gallery + wizard.
  presets: () => api<{ presets: AIProviderPreset[] }>("GET", "/ai/provider-presets"),
  // Live rate-limit budget for one provider.
  rateLimit: (id: number) =>
    api<{ rate_limit_rpm: number; rate_limit_tpm: number; remaining?: ProviderRateRemaining }>(
      "GET",
      `/ai/providers/${id}/ratelimit`,
    ),
  // Per-provider usage (same envelope as aiUsageService.summary).
  usage: (id: number, days = 30, scope?: "me" | "all") =>
    api<AIUsageSummary>("GET", `/ai/providers/${id}/usage`, { query: { days, scope } }),
  // SSE health stream URL (fed to useSseSnapshot — NOT a fetch).
  healthStreamURL: () => buildURLFromAPI("/ai/provider-health/stream"),
  // One-shot health snapshot (non-streaming consumers).
  health: () => api<ProviderHealthSnapshot>("GET", "/ai/provider-health"),
  probeHealth: () => api<ProviderHealthSnapshot>("POST", "/ai/provider-health/probe"),
}

export interface ProviderRateRemaining {
  req_limit: number
  req_remaining: number
  tok_limit: number
  tok_remaining: number
  reset_in_seconds: number
}

export interface ProviderHealthSnapshot {
  providers: Record<number, ProviderHealth>
  sampled_at: string
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
    api<{ conversation: AIConversation; messages: AIMessage[]; invocations: AIToolInvocation[]; plan?: AITask[] }>(
      "GET",
      `/ai/conversations/${id}`
    ),
  // The long-horizon agent's live task plan (panel state).
  tasks: (id: string) => api<{ plan: AITask[] }>("GET", `/ai/conversations/${id}/tasks`),
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
  // Deliver a user's reply to a waiting ask_user invocation.
  answer: (id: string, invId: string, answer: string) =>
    api<void>("POST", `/ai/conversations/${id}/invocations/${invId}/answer`, { body: { answer } }),
  editMessage: (id: string, msgId: number, text: string) =>
    api<{ ok: boolean; message_count: number; edited_message_id: number; text: string }>(
      "PATCH",
      `/ai/conversations/${id}/messages/${msgId}`,
      { body: { text } },
    ),
  exportMarkdownURL: (id: string) =>
    withTokenQuery(`/api/proxy/api/v1/ai/conversations/${id}/export.md`),
  // In-conversation full-text search → matching message ids + snippets to jump to.
  searchMessages: (id: string, q: string) =>
    api<{ hits: { message_id: number; role: string; snippet: string; created_at: string }[]; count: number }>(
      "GET",
      `/ai/conversations/${id}/search`,
      { query: { q } },
    ),
  // Cursor-paginated history (oldest-first page; next_before_id is the cursor).
  listMessages: (id: string, beforeId?: number, limit = 50) =>
    api<{ messages: AIMessage[]; next_before_id: number; has_more: boolean }>(
      "GET",
      `/ai/conversations/${id}/messages`,
      { query: { before_id: beforeId, limit } },
    ),
  // Fork the conversation (active branch up to upto_message_id; omit = all).
  fork: (id: string, uptoMessageId?: number) =>
    api<AIConversation>("POST", `/ai/conversations/${id}/fork`, {
      body: { upto_message_id: uptoMessageId },
    }),
  // Branch points (parents with >1 child) for the sibling switcher.
  branches: (id: string) =>
    api<{ branches: { parent_id: number; siblings: number[] }[]; active_leaf: number | null }>(
      "GET",
      `/ai/conversations/${id}/branches`,
    ),
  setActiveLeaf: (id: string, messageId: number | null) =>
    api<AIConversation>("POST", `/ai/conversations/${id}/active-leaf`, {
      body: { message_id: messageId },
    }),
  autotitle: (id: string) =>
    api<{ title: string }>("POST", `/ai/conversations/${id}/autotitle`),
}

export interface AIUsageBucket {
  day: string
  model: string
  input_tokens: number
  output_tokens: number
  cache_read_tokens: number
  cache_write_tokens: number
  cost_micros: number
  messages: number
}
export interface AIUsageSummary {
  buckets: AIUsageBucket[]
  totals: {
    input_tokens: number
    output_tokens: number
    cache_read_tokens: number
    cache_write_tokens: number
    cost_micros: number
    messages: number
  }
  scope: "me" | "all"
  can_admin: boolean
  days: number
}
export const aiUsageService = {
  summary: (days = 30, scope?: "me" | "all") =>
    api<AIUsageSummary>("GET", "/ai/usage", { query: { days, scope } }),
}

// ----- AI knowledge base (RAG) + long-term memory -----
//
// Distinct top-level segments (/ai/knowledge-bases, /ai/knowledge-search,
// /ai/embedding-setting, /ai/memories) avoid colliding with the /providers|
// /agents|/conversations :id param nodes on the Gin router.
export const aiKnowledgeService = {
  listKBs: () => api<{ knowledge_bases: AIKnowledgeBase[] }>("GET", "/ai/knowledge-bases"),
  createKB: (body: Partial<AIKnowledgeBase>) =>
    api<{ id: number; embedding_model: string }>("POST", "/ai/knowledge-bases", { body }),
  updateKB: (id: number, body: Partial<AIKnowledgeBase>) =>
    api<{ id: number }>("PATCH", `/ai/knowledge-bases/${id}`, { body }),
  removeKB: (id: number) => api<void>("DELETE", `/ai/knowledge-bases/${id}`),

  listDocs: (kbId: number) =>
    api<{ documents: AIDocument[] }>("GET", `/ai/knowledge-bases/${kbId}/documents`),
  uploadDoc: (
    kbId: number,
    file: File | Blob,
    opts: { name?: string; onProgress?: UploadOptions["onProgress"]; signal?: AbortSignal } = {},
  ) =>
    apiUpload<{ id: number; status: KBIngestStatus; duplicate?: boolean }>(
      `/ai/knowledge-bases/${kbId}/documents`,
      file,
      { query: opts.name ? { name: opts.name } : {}, onProgress: opts.onProgress, signal: opts.signal },
    ),
  importURL: (kbId: number, url: string, title?: string) =>
    api<{ id: number; status: KBIngestStatus }>("POST", `/ai/knowledge-bases/${kbId}/import-url`, { body: { url, title } }),
  reingestDoc: (kbId: number, docId: number) =>
    api<{ id: number; status: KBIngestStatus }>("POST", `/ai/knowledge-bases/${kbId}/documents/${docId}/reingest`),
  removeDoc: (kbId: number, docId: number) =>
    api<void>("DELETE", `/ai/knowledge-bases/${kbId}/documents/${docId}`),
  // Live ingest-status stream (event: snapshot → { documents: AIDocument[] }).
  ingestStreamURL: (kbId: number) => buildURLFromAPI(`/ai/knowledge-bases/${kbId}/ingest/stream`),

  search: (kbId: number, query: string, topK?: number) =>
    api<{ hits: { chunk_id: number; document_id: number; document: string; knowledge_base: string; text: string; score: number; match?: "vector" | "keyword" | "hybrid" }[] }>(
      "POST",
      "/ai/knowledge-search",
      { body: { knowledge_base_id: kbId, query, top_k: topK } },
    ),

  embeddingSetting: () =>
    api<{ provider_id: number; model: string; dimensions: number }>("GET", "/ai/embedding-setting"),
  setEmbeddingSetting: (body: { provider_id: number; model: string; dimensions?: number }) =>
    api<{ ok: boolean }>("PUT", "/ai/embedding-setting", { body }),
}

export const aiMemoryService = {
  list: (opts: { agent_id?: number; user_id?: number; q?: string } = {}) =>
    api<{ memories: AIMemory[] }>("GET", "/ai/memories", { query: opts }),
  update: (id: number, content: string) =>
    api<{ id: number }>("PATCH", `/ai/memories/${id}`, { body: { content } }),
  remove: (id: number) => api<void>("DELETE", `/ai/memories/${id}`),
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
  /** Aggregate busy-time breakdown over the last interval (0..100; -1 until 2 samples). */
  user_pct: number
  system_pct: number
  iowait_pct: number
  steal_pct: number
  /** Per-logical-CPU busy percentage, ordered by core index. Empty until a delta exists. */
  per_core?: number[]
  /** Current core frequency in MHz, best-effort. */
  mhz?: number
  /** Package temperature in °C, 0 if unknown. */
  temp_c?: number
}
export interface InsightsDiskIO {
  device: string
  read_bps: number
  write_bps: number
  read_iops: number
  write_iops: number
  util_pct: number
}
export interface InsightsTemp {
  label: string
  temp_c: number
}
export interface InsightsProcSummary {
  total: number
  running: number
  sleeping: number
  stopped: number
  zombie: number
  threads?: number
}
export interface InsightsLoginUser {
  user: string
  tty: string
  from?: string
  login?: string
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
  disk_io?: InsightsDiskIO[]
  interfaces: InsightsIface[]
  temps?: InsightsTemp[]
  procs: InsightsProcSummary
  sessions?: InsightsLoginUser[]
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
  ApprovalPreflight,
  ApprovalRequest,
  ApprovalRequestDetail,
  ApprovalSubscription,
  ApprovalTask,
  ApprovalTemplate,
  ApprovalOverview,
  ApprovalInboxItem,
  ApprovalGrantRow,
  ApprovalStats,
  ApprovalBulkDecideResult,
  ChainVerifyResult,
  ApprovalBusinessType,
  DBColumnInfo,
  DBExecResult,
  DBForeignKeyInfo,
  DBIndexInfo,
  DBProcessInfo,
  DBColumnStats,
  DBDatabaseStats,
  DBMultiQueryResult,
  DBQueryResult,
  DBTriggerInfo,
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
  // Per-user workspace summary strip.
  overview: () => api<ApprovalOverview>("GET", "/approvals/overview"),
  // Admin governance snapshot.
  stats: () => api<ApprovalStats>("GET", "/approvals/stats"),
  // Workspace connection gate — call before connecting.
  preflight: (q: { resource_type?: string; resource_id: string; business_type?: string; action?: string }) =>
    api<ApprovalPreflight>("GET", "/approvals/preflight", {
      query: {
        resource_type: q.resource_type ?? "node",
        resource_id: q.resource_id,
        business_type: q.business_type ?? "asset_access",
        action: q.action ?? "connect",
      },
    }),
  // SSE stream URLs (consumed via lib/sse streamSSE — literal proxy path).
  requestStreamURL: (id: string) => `/api/proxy/api/v1/approvals/${id}/stream`,
  userStreamURL: () => `/api/proxy/api/v1/approvals/stream`,
  cancel: (id: string, reason: string) =>
    api<{ ok: true }>("POST", `/approvals/${id}/cancel`, { body: { reason } }),
  verifyChain: (id: string) =>
    api<ChainVerifyResult>("GET", `/approvals/${id}/audit/verify`),
  myTasks: (limit = 50) =>
    api<{ items: ApprovalTask[] }>("GET", "/approvals/tasks/me", { query: { limit } }),
  // Enriched approver inbox (task + parent request, one round-trip).
  inbox: (limit = 100) =>
    api<{ items: ApprovalInboxItem[] }>("GET", "/approvals/tasks/inbox", { query: { limit } }),
  approve: (taskId: number, comment: string, durationSec?: number) =>
    api<unknown>("POST", `/approvals/tasks/${taskId}/approve`, {
      body: { comment, approve: true, duration_sec: durationSec ?? 0 },
    }),
  reject: (taskId: number, comment: string) =>
    api<unknown>("POST", `/approvals/tasks/${taskId}/reject`, { body: { comment, approve: false } }),
  // Apply one verdict to many owned tasks; per-row results come back.
  bulkDecide: (taskIds: number[], approve: boolean, comment: string, durationSec?: number) =>
    api<ApprovalBulkDecideResult>("POST", "/approvals/tasks/bulk", {
      body: { task_ids: taskIds, approve, comment, duration_sec: durationSec ?? 0 },
    }),
  delegate: (taskId: number, delegate_to_id: number, comment: string) =>
    api<{ task: ApprovalTask }>("POST", `/approvals/tasks/${taskId}/delegate`, {
      body: { delegate_to_id, comment },
    }),
  // Issued-grant views.
  myGrants: (status?: string, limit = 100) =>
    api<{ items: ApprovalGrantRow[]; total: number }>("GET", "/approvals/grants/mine", {
      query: { status, limit },
    }),
  grants: (query: { beneficiary_id?: number; status?: string; limit?: number; offset?: number } = {}) =>
    api<{ items: ApprovalGrantRow[]; total: number }>("GET", "/approvals/grants", { query }),
  revokeGrant: (grantId: string, reason: string) =>
    api<{ ok: true }>("POST", `/approvals/grants/${grantId}/revoke`, { body: { reason } }),
  // Self-service early release of one's own grant.
  releaseGrant: (grantId: string, reason?: string) =>
    api<{ ok: true }>("POST", `/approvals/grants/${grantId}/release`, { body: { reason } }),
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
  // Phase 22 — cluster-level engine catalogue + per-node capabilities.
  // Front-end consumers cache both for the lifetime of the tab.
  engines: () => api<{ engines: import("./types").DBEngineInfo[] }>("GET", "/db/engines"),
  capabilities: (nodeId: number) =>
    api<import("./types").DBCapabilities>("GET", `/nodes/${nodeId}/db/capabilities`),
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
    // Phase 30 — `filter` adds a server-side multi-column LIKE WHERE
    // clause across text-shaped columns. Empty/omitted disables.
    opts: {
      limit?: number; offset?: number;
      order_by?: string; order_dir?: "ASC" | "DESC";
      database?: string; filter?: string;
    } = {}
  ) =>
    api<DBQueryResult>("GET", `/nodes/${nodeId}/db/rows`, {
      query: { schema, table, ...opts },
    }),
  // Phase 30f — per-column data summary: distinct / null / total counts,
  // min/max for orderable types, top-N value frequencies.
  columnStats: (
    nodeId: number, schema: string, table: string, column: string,
    opts: { database?: string; top?: number } = {}
  ) =>
    api<DBColumnStats>("GET", `/nodes/${nodeId}/db/column_stats`, {
      query: { schema, table, column, database: opts.database, top: opts.top },
    }),
  // Phase 30c — per-table trigger list. Empty array when none exist
  // or the engine has no programmable triggers.
  triggers: (nodeId: number, schema: string, table: string, database?: string) =>
    api<{ triggers: DBTriggerInfo[] }>("GET", `/nodes/${nodeId}/db/triggers`, {
      query: { schema, table, database },
    }),
  // Phase 30 — per-database health snapshot. Cheap (one round-trip
  // per stat); the UI calls every 30s for a live status bar.
  databaseStats: (nodeId: number, database?: string) =>
    api<DBDatabaseStats>("GET", `/nodes/${nodeId}/db/database_stats`, {
      query: { database },
    }),
  // Phase 30 — multi-statement script execution. The server splits the
  // script on top-level ; (string / dollar-quote aware) and runs each
  // statement, returning per-statement results. The whole script gets
  // one approval check if ANY statement is non-read-only.
  queryMulti: (
    nodeId: number,
    script: string,
    opts: { database?: string; reason?: string } = {}
  ) =>
    api<{ results: DBMultiQueryResult[]; count: number }>(
      "POST",
      `/nodes/${nodeId}/db/query-multi`,
      { body: { script, database: opts.database, reason: opts.reason } }
    ),
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

// ---------- System settings (super-admin runtime configuration) ----------
export const settingsService = {
  schema: () => api<SettingsSchema>("GET", "/settings/schema"),
  update: (changes: Record<string, unknown>) =>
    api<{ ok: boolean; restart_keys: string[] | null }>("POST", "/settings", { body: { changes } }),
  reset: (keys: string[]) => api<{ ok: boolean }>("POST", "/settings/reset", { body: { keys } }),
  integrations: () =>
    api<{ ok: boolean; integrations: IntegrationStatus[] }>("GET", "/settings/integrations"),
  test: (id: string) =>
    api<{ ok: boolean; integration: IntegrationStatus }>("POST", `/settings/integrations/${id}/test`),
  audits: () => api<{ ok: boolean; audits: SettingsAudit[] }>("GET", "/settings/audits"),
}
