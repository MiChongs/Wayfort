// TypeScript mirror of the backend's GORM rows. Field names follow the JSON
// produced by the backend (snake_case). Only the fields the UI uses are
// declared; everything else is allowed via index signature so we don't break
// when the backend adds optional fields.

export interface User {
  id: number
  username: string
  display_name?: string
  email?: string
  phone?: string
  avatar_url?: string
  /** Denormalised primary department (first of department_ids). */
  department_id?: number | null
  /** Full multi-department membership set. */
  department_ids?: number[]
  is_admin?: boolean
  disabled?: boolean
  mfa_enforced?: boolean
  passkey_only?: boolean
  /** 账号生命周期：active(在职) | suspended(停用) | departed(离职)。空串视同 active。 */
  status?: string
  /** 账号到期时刻；到点后拒绝登录。null / 缺省 = 永不过期。 */
  expires_at?: string | null
  /** 管理员备注（为什么开号、归属、注意事项）。 */
  note?: string
  /** 被打上的受管标签 ID（复用 asset_tags 标签定义）。 */
  tag_ids?: number[]
  last_login_at?: string | null
  last_login_ip?: string
  last_user_agent?: string
  locked_until?: string | null
  password_changed?: string | null
  created_at?: string
  updated_at?: string
}

/** 用户概览统计（GET /users/stats）。 */
export interface UserStats {
  total: number
  /** 可登录人数：未禁用 / 停用 / 离职 / 过期。 */
  active: number
  disabled: number
  admin: number
  /** 当前被登录失败锁定的人数。 */
  locked: number
  /** 已过期的账号数。 */
  expired: number
  /** 近 7 天有登录的人数。 */
  recent_7d: number
  /** 近 N 天每日新增（用于趋势图）。 */
  trend: { date: string; count: number }[]
}

/** 用户 360° 详情（GET /users/:id）。 */
export interface UserDetail {
  user: User
  roles: Role[]
  sessions: Session[]
  session_total: number
  login_history: LoginHistory[]
  grants: AssetGrant[]
}

export type NodeProtocol =
  | "ssh"
  | "telnet"
  | "rdp"
  | "vnc"
  | "mysql"
  | "postgres"
  | "redis"
  | "mongo"
  | "tcp"
  // Phase 22+ — Chinese DB stack registered via the dbquery plugin
  // registry. Family-MySQL engines reuse the MySQL adapter; Family-PG
  // engines reuse the Postgres adapter; Dameng (DM8) has its own
  // Oracle-flavoured adapter.
  | "dameng"
  | "kingbase"
  | "vastbase"
  | "highgo"
  | "opengauss"
  | "gaussdb"
  | "tidb"
  | "oceanbase"
  | "starrocks"
  | "doris"
  | "gbase8a"
  | "gbase8s"
  // Object storage bastion (Aliyun OSS / Tencent COS / S3-compatible).
  | "oss"

// ----- OSS object storage -----

export type OssProvider = "aliyun" | "tencent" | "s3"

export interface OssBucket {
  name: string
  region?: string
  creation_date?: string
}

// One listing row: an object (file) or a common-prefix (folder, is_dir=true).
export interface OssEntry {
  key: string
  name: string
  is_dir: boolean
  size: number
  last_modified?: string
  etag?: string
  storage_class?: string
}

export interface OssListResult {
  bucket: string
  prefix: string
  delimiter: string
  entries: OssEntry[] | null
  next_token?: string
  truncated: boolean
}

export interface OssObjectMeta {
  key: string
  size: number
  content_type?: string
  etag?: string
  last_modified?: string
  storage_class?: string
}

export interface OssStats {
  bucket: string
  prefix: string
  object_count: number
  total_size: number
  scanned: number
  truncated: boolean
  storage_class: { class: string; count: number; size: number }[]
  size_histogram: { label: string; count: number }[]
  largest: { key: string; size: number }[]
}

// DBEngineFamily mirrors internal/dbquery.Family — a coarse
// compatibility band the UI uses to render per-engine SQL hints.
export type DBEngineFamily = "mysql" | "postgres" | "oracle"

// DBCapabilities mirrors internal/dbquery.Capabilities. The DB Studio
// consumes one of these per node and conditionally renders / disables
// every toolbar button, sidebar section and row affordance.
export interface DBCapabilities {
  list_databases: boolean
  schemas: boolean
  row_edits: boolean
  explain: boolean
  explain_analyze: boolean
  processes: boolean
  kill_process: boolean
  table_ddl: boolean
  table_stats: boolean
  foreign_keys: boolean
  export: boolean
  last_insert_id: boolean
  sequences: boolean
  functions: boolean
  transactions: boolean
  database_scope: "catalog" | "schema"
  vendor_label?: string
}

// DBEngineInfo is one entry of the cluster-level engine catalog
// returned by GET /db/engines. The "新增节点" sheet renders it as the
// protocol dropdown; the DB Studio renders it on the empty state.
export interface DBEngineInfo {
  protocol: NodeProtocol
  family: DBEngineFamily
  vendor_label: string
  capabilities: DBCapabilities
}

export interface Node {
  id: number
  name: string
  protocol: NodeProtocol
  host: string
  port: number
  username: string
  credential_id: number
  proxy_chain: string
  // Network domain — the source of truth for HOW the gateway reaches this node
  // (direct / proxy chain / reverse-connect agent). Omitted = the default direct
  // domain; a non-empty proxy_chain above is a deprecated per-node override that
  // still wins during the compatibility window.
  domain_id?: number
  // Per-protocol tuning, stored as a JSON string. RDP-specific fields go
  // under the `rdp` sub-object; see RdpProtoOptions below. Older Guacamole
  // nodes may have flat-form `{"security":..., "domain":...}` — the
  // backend still parses both shapes.
  proto_options?: string
  tags?: string
  // Unified icon token ("simple:postgresql" / "lucide:server" / "emoji:🐳" /
  // "text:DB"). Empty → derived from protocol via lib/icons/protocol.
  icon?: string
  region?: string
  description?: string
  disabled?: boolean
  // Phase 16 approval gates — exposed in the node form now.
  requires_approval_for_connect?: boolean
  requires_approval_for_file_xfer?: boolean
  // Resolved by the list/detail endpoints so the UI never shows a bare #id.
  credential_name?: string
  proxy_names?: string[]
  // Managed colour tags resolved by the list/detail endpoints. The freetext
  // `tags` string above is kept as a synced cache for search/facets.
  tag_list?: AssetTag[]
  created_at?: string
  updated_at?: string
}

// Connectivity-probe result from POST /nodes/:id/test.
export interface NodeTestResult {
  ok: boolean
  mode?: "ssh" | "tcp"
  error?: string
  latency_ms?: number
  target?: string
}


// Result shape for the bulk tree actions (add/remove nodes to a group, attach/
// detach a tag across nodes): a success count plus any per-id failures so
// partial success is surfaced rather than swallowed.
export interface BatchResult {
  ok: number
  failed?: { id: number; error: string }[]
}

// Server-side node list filter params (all optional).
export interface NodeListParams {
  q?: string
  protocol?: string
  tag?: string
  enabled?: "true" | "false"
  sort?: "name" | "protocol" | "host" | "created_at" | "updated_at"
  order?: "asc" | "desc"
}

// --- access tier + dashboard (role-aware) ---

export type AccessTier = "superadmin" | "admin" | "user"

export interface AccessInfo {
  tier: AccessTier
  is_superadmin: boolean
  is_admin: boolean
  permissions: string[]
}

// --- edition / licensing ---

export type EditionTier = "community" | "enterprise" | "flagship"
export type EditionState = "community" | "active" | "grace" | "expired" | "invalid"
export type EditionFeature =
  | "break_glass"
  | "security_analytics"
  | "reverse_agent"
  | "ai"
  | "desktop"
  | "advanced_kms"
  | "connection_review"
  | "data_masking"
  | "connection_method"

// Slim payload from GET /me/edition — only what nav-gating + the banner need.
export interface EditionInfo {
  edition: EditionTier
  state: EditionState
  features: Partial<Record<EditionFeature, boolean>>
  message?: string
}

// --- access control (consolidated 访问控制 rule module) ---

export type AccessRuleKind =
  | "command_filter"
  | "user_login"
  | "asset_connection_review"
  | "data_masking"
  | "connection_method"

export type AccessRuleAction = "accept" | "deny" | "review" | "notify" | "alert"

// AccessRuleScope is the decoded form of a dimension column (users/assets/
// accounts). Empty/undefined column ⇒ {all:true}. Account dimension = credential.
export interface AccessRuleScope {
  all?: boolean
  user_ids?: number[]
  group_ids?: number[]
  dept_ids?: number[]
  role_ids?: number[]
  node_ids?: number[]
  asset_group_ids?: number[]
  tag_ids?: number[]
  credential_ids?: number[]
}

export interface AccessRuleTimeWindow {
  weekdays?: number[] // 0=Sun..6=Sat; empty = every day
  start?: string // "HH:MM"
  end?: string
}

export interface AccessRule {
  id: number
  kind: AccessRuleKind
  name: string
  description?: string
  priority: number
  active: boolean
  is_system?: boolean
  users?: string // JSON-encoded AccessRuleScope
  assets?: string
  accounts?: string
  ip_rule?: string
  time_window?: string // JSON-encoded AccessRuleTimeWindow
  action: AccessRuleAction
  spec?: string
  valid_from?: string
  valid_to?: string
  created_at?: string
  updated_at?: string
}

export interface AccessRuleInput {
  kind: AccessRuleKind
  name: string
  description?: string
  priority?: number
  active?: boolean
  users?: string
  assets?: string
  accounts?: string
  ip_rule?: string
  time_window?: string
  action: AccessRuleAction
  spec?: string
}

// Richer payload from GET /admin/edition (super-admin license manager).
export interface AdminEditionInfo {
  edition: EditionTier
  state: EditionState
  licensed: boolean
  supported: boolean
  features: Partial<Record<EditionFeature, boolean>>
  limits?: Record<string, number>
  customer?: string
  license_id?: string
  issued_at?: string
  expires_at?: string
  grace_until?: string
  message?: string
}

export interface DashKV {
  name: string
  value: number
}
export interface DashDay {
  date: string
  count: number
}
export interface DashSession {
  id: string
  username: string
  node_name: string
  kind: string
  status: string
  started_at: string
}
export interface DashboardSummary {
  tier: AccessTier
  scope: "system" | "personal"
  stats: Record<string, number>
  sessions_daily: DashDay[]
  sessions_by_kind: DashKV[]
  sessions_by_status?: DashKV[]
  top_nodes?: DashKV[]
  recent_sessions: DashSession[]
}

// RDP security negotiation mode persisted under proto_options.rdp.security.
//   "any" lets libfreerdp pick the strongest mutually-supported layer
//   "nla" forces Network Level Authentication (CredSSP)
//   "tls" forces plain TLS — used when NLA is disabled on the server
//   "rdp" forces legacy RDP encryption (very old Windows compatibility)
export type RdpSecurity = "any" | "nla" | "tls" | "rdp"

// RdpProtoOptions mirrors internal/desktop/RdpOptions on the Go side. All
// fields are optional — omitting one means "use the worker default".
export interface RdpProtoOptions {
  security?: RdpSecurity
  tls_sec_level?: number
  ignore_cert?: boolean
  domain?: string
  keyboard?: string
  color_depth?: 16 | 24 | 32
  console_session?: boolean

  // High-DPI scaling for this node. Unset = on (default): sessions render at the
  // browser's physical-pixel resolution with matching Windows display scaling.
  // Set false for legacy servers that mis-handle scale factors. max_scale caps
  // the per-session scale factor in percent (0/unset = no cap). freerdp backend.
  high_dpi?: boolean
  max_scale?: number

  // dynamic_resolution lets the remote desktop resolution track the browser
  // window live (DRDYNVC `disp` display channel) instead of staying pinned to the
  // connect-time size — a window resize reflows the remote at native 1:1 with no
  // scaling blur. Off by default. freerdp backend only.
  dynamic_resolution?: boolean

  enable_remote_fx?: boolean
  enable_nscodec?: boolean
  enable_h264?: boolean
  enable_graphics_pipeline?: boolean

  // gfx_codec biases the RDPGFX codec negotiation for the legacy bitmap path,
  // honoured only when the browser advertises the matching decode capability:
  //   "auto"   — H.264/AVC420 when supported (current behaviour)
  //   "avc444" — 4:4:4 full-chroma H.264 (sharpest coloured text; Phase 2 decoder)
  //   "avc420" — single-stream H.264 (4:2:0)
  //   "rfx"    — RemoteFX progressive   "nsc" — NSCodec   "none" — Planar only
  gfx_codec?: "auto" | "avc444" | "avc420" | "rfx" | "nsc" | "none"
  // prefer_av1 opts the session into AV1 when it can be negotiated (host-side
  // RDPGFX passthrough or server-side encode), falling back to H.264/VP9. Off by
  // default (browser AV1 decode support is still uneven). freerdp backend only.
  prefer_av1?: boolean

  disable_wallpaper?: boolean
  disable_full_window_drag?: boolean
  disable_menu_anims?: boolean
  disable_themes?: boolean
  allow_font_smoothing?: boolean
  allow_desktop_composition?: boolean

  redirect_clipboard?: boolean
  audio_playback?: boolean
  device_redirection?: boolean

  tcp_connect_timeout_ms?: number
  tcp_ack_timeout_ms?: number

  // ----- Network / bandwidth profile (Phase 1) -----
  // network_preset is a one-shot link-class profile that fills the codec /
  // compression / connection-type / visual-trim defaults below. The preset only
  // fills fields left unset — explicit per-field choices always win. Mirrors
  // FreeRDP's /network:<type>.
  //   "lan"       — full visuals, 32bpp, no bulk compression
  //   "broadband" — 32bpp, light trim
  //   "wan"       — 16bpp, bulk compression, trim wallpaper/anims
  //   "mobile"    — modem/cellular: 16bpp, aggressive trim, bulk compression
  //   "auto"      — keep visuals, let the WebRTC ABR loop pace bitrate
  network_preset?: "lan" | "broadband" | "wan" | "mobile" | "auto"
  // connection_type overrides the RDP CONNECTION_TYPE hint advertised to the
  // server: 1=modem 2=broadband-low 3=satellite 4=broadband-high 5=wan 6=lan
  // 7=autodetect. Unset = worker default (broadband-low).
  connection_type?: 1 | 2 | 3 | 4 | 5 | 6 | 7
  // bulk_compression toggles MPPC/RDP6 bulk data compression — trades worker CPU
  // for fewer bytes on the legacy bitmap/cache path (worthwhile on WAN/mobile,
  // pointless on LAN, irrelevant to the already-compressed GFX/H.264/VP9 paths).
  bulk_compression?: boolean
  // compression_level selects the generation when bulk_compression is on:
  // 0=RDP4(8K) 1=RDP5(64K) 2=RDP6 3=RDP6.1. Unset = 2.
  compression_level?: 0 | 1 | 2 | 3

  // RD Gateway (Microsoft Remote Desktop Gateway, MS-TSGU). gateway_host set =
  // tunnel the RDP connection through the gateway (for hosts published only via
  // an RD Gateway). gateway_use_same_credentials (default true) reuses the
  // target login; otherwise gateway_credential_id supplies a dedicated gateway
  // credential. gateway_transport: "auto" | "http" | "rpc".
  gateway_host?: string
  gateway_port?: number
  gateway_domain?: string
  gateway_use_same_credentials?: boolean
  gateway_credential_id?: number
  gateway_transport?: "auto" | "http" | "rpc"
}

// ProtoOptionsEnvelope is the structured shape persisted as a JSON string
// in node.proto_options. Each protocol owns its own sub-object so future
// VNC / SSH / DB tuning can land without colliding with RDP.
export interface ProtoOptionsEnvelope {
  rdp?: RdpProtoOptions
}

export type CredentialKindT = "password" | "private_key" | "agent" | "access_key"

export interface Credential {
  id: number
  name: string
  kind: CredentialKindT
  username: string
  description?: string
  tags?: string
  expires_at?: string | null
  last_used_at?: string | null
  last_tested_at?: string | null
  last_test_ok?: boolean | null
  requires_approval_for_use?: boolean
  // Enriched by the list endpoint — reference tallies for "used by N / M".
  usage_nodes?: number
  usage_proxies?: number
  created_at?: string
  updated_at?: string
}

// Request shape for create/update. On update, an empty `secret` means "keep the
// existing secret" (metadata-only edit); a `passphrase` of "-" clears it.
export interface CredentialInput {
  name: string
  kind: CredentialKindT
  username?: string
  secret?: string
  passphrase?: string
  description?: string
  tags?: string
  expires_at?: string | null
  requires_approval_for_use?: boolean
}

// A node or proxy that references a credential (from /credentials/:id/usage and
// the 409 body returned by a blocked delete).
export interface CredentialUsageRef {
  id: number
  name: string
  host: string
  kind?: string
}
export interface CredentialUsage {
  nodes: CredentialUsageRef[]
  proxies: CredentialUsageRef[]
}
export interface CredentialTestResult {
  ok: boolean
  error?: string
  latency_ms?: number
  target?: string
}

export type ProxyKind = "direct" | "socks5" | "socks4" | "bastion" | "http_connect" | "failover"

export type FailoverStrategy = "ordered" | "round_robin" | "health_weighted"

// ProxyFailoverGroup is the structured payload for a failover hop. The chain CSV
// still references it by a single proxy id; members live here.
export interface ProxyFailoverGroup {
  members: number[] // ordered member proxy ids
  strategy: FailoverStrategy
  retry: number
  backoff_ms: number
}

// Network domain — the single source of truth for a node's connectivity
// (how the gateway reaches it). Authorisation stays orthogonal. See the backend
// internal/domain package and docs/security-architecture.md §3.
export type DomainKind = "direct" | "proxy" | "agent"

export interface Domain {
  id: number
  name: string
  kind: DomainKind
  description?: string
  // proxy domains only: ordered comma-separated proxy-id chain (same format as
  // Node.proxy_chain), may terminate in a failover group.
  proxy_chain?: string
  // comma-separated NodeProtocol whitelist; empty = all allowed.
  allowed_protocols?: string
  max_concurrent_sessions?: number
  // the built-in default direct domain — pinned to direct, undeletable.
  is_default?: boolean
  created_at?: string
  updated_at?: string
}

// Reverse-connect Gateway Agent (security-architecture.md §4). Lives inside an
// agent domain's isolated network and dials targets on the gateway's behalf.
export type AgentStatus = "pending" | "online" | "offline" | "revoked"

export interface GatewayAgent {
  id: number
  domain_id: number
  name: string
  status: AgentStatus
  version?: string
  fingerprint?: string
  enroll_ip?: string
  cert_expires_at?: string
  last_seen_at?: string
  last_gateway?: string
  stats?: string
  // live registry status: is the agent connected to this gateway right now.
  connected?: boolean
  created_at?: string
  updated_at?: string
}

// The one-time enrollment token response — the plaintext token is shown exactly
// once for the admin to paste into the agent's enroll command.
export interface AgentEnrollToken {
  token: string
  expires_at: string
  domain_id: number
}

// Reverse-connect agent面 status — drives the install command and the
// "listener disabled" warning (security-architecture.md §4/§14).
export interface AgentGatewayInfo {
  enabled: boolean // is the mTLS listener actually up?
  server: string // wss://host:port the agent dials
  script_path: string // origin-relative installer path (e.g. /dl/gateway-agent.sh)
  binary_ready: boolean // is a binary staged for download?
}

// Internal PKI (security-architecture.md §6) — the embedded CA's metadata and
// the issued-certificate ledger.
export interface PKICAInfo {
  subject: string
  not_before: string
  not_after: string
  bundle: string
  mode: string // "embedded" | "step-ca"
}

export type PKICertStatus = "active" | "expired" | "revoked"

export interface PKICertificate {
  serial: string
  subject_kind: string // "agent" | "service"
  subject_id: number
  fingerprint: string
  not_before: string
  not_after: string
  status: PKICertStatus
  revoke_reason?: string
}

export interface Proxy {
  id: number
  name: string
  kind: ProxyKind
  host: string
  port: number
  credential_id?: number | null
  description?: string
  disabled?: boolean
  tags?: string
  // Per-hop connect timeout (ms); 0 → server default.
  timeout_ms?: number
  // http_connect transport knobs.
  tls_to_proxy?: boolean
  insecure_tls?: boolean
  proxy_sni?: string
  headers?: Record<string, string>
  // socks4 — resolve the destination name proxy-side (SOCKS4a).
  socks4_remote?: boolean
  // failover — present only when kind === "failover".
  group?: ProxyFailoverGroup
  created_at?: string
  updated_at?: string
}

// --- live health (background prober) ---
export type ProxyHealthState = "online" | "degraded" | "down" | "unknown"

export interface ProxyHealth {
  proxy_id: number
  name?: string
  kind?: ProxyKind
  up: boolean
  state: ProxyHealthState
  latency_ms: number
  last_error?: string
  checked_at: string
  consecutive_up?: number
  consecutive_down?: number
}

export interface ProxyHealthSnapshot {
  proxies: Record<number, ProxyHealth>
  sampled_at: string
}

// --- connection metrics ---
export interface ProxyMetric {
  proxy_id: number
  active_conns: number
  total_dials: number
  failures: number
  success_rate: number // 0..1
  bytes_in: number
  bytes_out: number
  avg_latency_ms: number
}

export interface ProxyMetricsSeriesPoint {
  ts: string
  dials: number
  failures: number
  active_conns: number
}

export interface ProxyMetricsSnapshot {
  proxies: Record<number, ProxyMetric>
  aggregate: {
    active_conns: number
    total_dials: number
    failures: number
    success_rate: number
    bytes_in: number
    bytes_out: number
  }
  series: ProxyMetricsSeriesPoint[]
  sampled_at: string
}

// Phase 10 — proxy chain validation, testing, templates.
export type ChainIssueSeverity = "error" | "warning" | "info"

export interface ChainIssue {
  hop: number
  proxy_id?: number
  severity: ChainIssueSeverity
  code: string
  message: string
}

export interface ChainValidationResult {
  hops: Proxy[]
  issues: ChainIssue[]
  valid: boolean
  resolve?: string
}

export interface ChainHopTestResult {
  hop: number
  proxy_id: number
  name: string
  kind: ProxyKind
  ok: boolean
  duration_ms: number
  error?: string
  // host:port actually dialed through the partial chain for this hop.
  probed?: string
}

export interface ChainTestResponse {
  hops: Proxy[]
  results: ChainHopTestResult[]
  ok: boolean
  target: string
}

export interface ProxyChainTemplate {
  id: number
  name: string
  description?: string
  chain: string
  tags?: string
  created_by?: number | null
  created_at?: string
  updated_at?: string
  // Hydrated by GET — pre-resolved hop list + per-template lint issues.
  hops?: Proxy[]
  issues?: ChainIssue[]
}

export type SessionKind =
  | "interactive"
  | "anonymous"
  | "sftp"
  | "graphical"
  | "tcp_forward"
  | "oss"

export type SessionStatus = "active" | "closed" | "terminated" | "errored"

export interface Session {
  id: string
  kind: SessionKind
  user_id: number
  username: string
  node_id?: number | null
  node_name?: string
  client_ip?: string
  started_at: string
  ended_at?: string | null
  status: SessionStatus
  recording_path?: string
  recording_type?: "asciicast" | "guac" | "desktop" | ""
  bytes_in?: number
  bytes_out?: number
  reason?: string
  // Lifecycle v3 rollups (zero/absent on pre-v3 rows).
  current_phase?: SessionPhaseKind | ""
  reconnect_count?: number
  peak_rtt_ms?: number
  avg_rtt_ms?: number
  ready_at?: string | null
}

// Lifecycle v3 — connection-stage timeline + connection-quality samples.
export type SessionPhaseKind =
  | "dial"
  | "auth"
  | "handshake"
  | "ready"
  | "reconnect"
  | "closed"

export type SessionPhaseStatus = "running" | "succeeded" | "failed"

export interface SessionPhase {
  id: number
  session_id: string
  seq: number
  phase: SessionPhaseKind
  status: SessionPhaseStatus
  started_at: string
  ended_at?: string | null
  duration_ms?: number | null
  detail?: string
}

export interface SessionMetricSample {
  id: number
  session_id: string
  at: string
  rtt_ms: number // primary: server RTT if measured, else client
  server_rtt_ms?: number // gateway↔target (SSH keepalive)
  client_rtt_ms?: number // browser↔gateway (WS ping)
  jitter_ms?: number // RTT variation (EWMA of |Δrtt|)
  loss_pct: number // ×100 (250 == 2.50%)
  bytes_in_delta: number
  bytes_out_delta: number
  reconnects: number
}

export interface SessionLifecycle {
  session: Session
  phases: SessionPhase[]
  samples: SessionMetricSample[]
}

// AuditEvent is one row of the per-session timeline — a reconstructed command,
// a file transfer, or a lifecycle marker.
export interface AuditEvent {
  id: number
  kind: string
  user_id: number
  username: string
  session_id?: string
  node_id?: number | null
  client_ip?: string
  payload?: string
  created_at: string
}

export interface SessionKeyCount {
  key: string
  count: number
}

export interface SessionDayCount {
  date: string
  count: number
}

export interface SessionStats {
  total: number
  active: number
  today: number
  recorded: number
  by_kind: SessionKeyCount[]
  by_status: SessionKeyCount[]
  trend: SessionDayCount[]
}

// ----- Global audit center -----

// AuditLogRow is one row of the global audit trail: an AuditEvent decorated by
// the backend with its category lane, an abnormal flag, and the resolved asset
// name (audit_logs stores only node_id).
export interface AuditLogRow extends AuditEvent {
  category: string
  abnormal: boolean
  node_name?: string
}

export interface AuditKeyCount {
  key: string
  count: number
}

export interface AuditDayCount {
  date: string
  count: number
  abnormal: number
}

export interface AuditStats {
  total: number
  today: number
  abnormal: number
  active_users: number
  trend: AuditDayCount[]
  by_category: AuditKeyCount[]
  top_users: AuditKeyCount[]
  top_nodes: AuditKeyCount[]
  top_ips: AuditKeyCount[]
  heatmap: number[][] // [7 weekdays][24 hours]
}

// M4 — audit tamper-evidence integrity report (security-architecture.md §5.2).
export interface AuditCheckpointView {
  day: string
  tail_hash: string
  entry_count: number
  dropped_count: number
  is_genesis: boolean
  signed: boolean
  created_at: string
}
export interface AuditChainReport {
  chain_id: string
  entry_count: number
  intact: boolean
  broken_at: number // -1 when intact
  truncated: boolean
  checkpoints: AuditCheckpointView[]
}
export interface AuditIntegrityReport {
  chains: AuditChainReport[]
  unprotected_rows: number
  unprotected_note: string
}

// AuditQuery is the filter set shared by the list, the live stream, and the
// CSV export. `kind` is a single exact kind (click-to-filter); the segmented
// control uses the coarser `category` lane instead.
export interface AuditQuery {
  category?: string
  kind?: string
  user_id?: number
  username?: string
  session_id?: string
  node_id?: number
  node_name?: string
  client_ip?: string
  q?: string
  only_abnormal?: boolean
  from?: string
  to?: string
  limit?: number
  offset?: number
}

// DriveInfo describes the per-user file drive redirected into RDP sessions.
export interface DriveInfo {
  enabled: boolean
  name: string
  allow_upload: boolean
  allow_download: boolean
  max_file_mb: number
  max_total_mb: number
  used_bytes: number
}

export interface DriveEntry {
  name: string
  is_dir: boolean
  size: number
  mod_time: string
}

export interface PortForward {
  id: string
  user_id: number
  username: string
  node_id: number
  local_host: string
  local_port: number
  target_host: string
  target_port: number
  created_at: string
  expires_at: string
  closed_at?: string | null
  status: "active" | "expired" | "closed" | "port_unavailable"
  bytes_in?: number
  bytes_out?: number
  label?: string
  tags?: string[]
  pinned?: boolean
}

export interface PortForwardPatch {
  label?: string
  tags?: string[]
  pinned?: boolean
}

export interface Role {
  id: number
  name: string
  description?: string
  is_system?: boolean
  permissions?: string[]
}

export interface Permission {
  code: string
  description?: string
  category?: string
}

export interface Department {
  id: number
  name: string
  description?: string
  icon?: string
  parent_id?: number | null
  path: string
  order_idx?: number
  /** Directly-assigned member user IDs (populated by the list endpoint). */
  member_ids?: number[]
}

export interface UserGroup {
  id: number
  name: string
  description?: string
  icon?: string
  parent_id?: number | null
  path?: string
  order_idx?: number
  /** Member user IDs (populated by the list endpoint). */
  member_ids?: number[]
}

export interface AssetGroup {
  id: number
  name: string
  parent_id?: number | null
  path: string
  description?: string
  // Member node IDs populated by the GET /asset-groups list endpoint.
  // Create/Update payloads don't include it, which is why this is optional.
  node_ids?: number[]
}

// A managed colour tag. `color` is a palette TOKEN ("coral"/"teal"/…) resolved
// to design-system classes by lib/tags/palette.ts — legacy rows may carry a raw
// "#rrggbb", which the resolver renders verbatim. `count` is the number of
// nodes carrying the tag (present on the list endpoint only).
export interface AssetTag {
  id: number
  name: string
  color?: string
  icon?: string
  description?: string
  group_id?: number | null
  count?: number
  created_at?: string
  updated_at?: string
}

// A namespace / category that organises tags (env, team, region…).
export interface AssetTagGroup {
  id: number
  name: string
  color?: string
  icon?: string
  sort_order?: number
  created_at?: string
  updated_at?: string
}

// ----- Workspace v2 — firewall + docker management -----

export type FirewallTool = "ufw" | "firewalld" | "nft" | "iptables" | ""
export type FirewallFamily = "inet" | "inet6" | ""
export interface FirewallStatus {
  tool: FirewallTool
  active: boolean
  installed: boolean
  policy?: string
  default_in?: string
  default_out?: string
  chains?: string[] | null
  ssh_port?: number
  rule_count: number
  reason?: string
  sampled_at: string
}
export interface FirewallRule {
  index: number
  action: string
  direction: string
  protocol?: string
  port?: string
  source?: string
  chain?: string
  family?: FirewallFamily
  handle?: number
  table?: string
  comment?: string
  pkts?: number
  bytes?: number
  raw: string
}
export interface FirewallRuleSpec {
  action: "ALLOW" | "DENY" | "REJECT"
  direction?: "in" | "out"
  protocol?: "tcp" | "udp" | "icmp" | "any"
  port: string
  source?: string
  comment?: string
}

// SSE snapshot — status (flat) + rules with live counters + exposure + f2b summary.
export interface FirewallSnapshot extends FirewallStatus {
  rules: FirewallRule[] | null
  exposure?: ExposurePort[] | null
  fail2ban?: { installed: boolean; banned_total: number; jail_count: number }
}

export type ExposureVerdict = "open" | "restricted" | "blocked" | "local"
export interface ExposurePort {
  proto: "tcp" | "udp"
  port: number
  listen_addr: string
  process?: string
  pid?: number
  verdict: ExposureVerdict
  allowed_from?: string[] | null
  rule_index?: number
}

export interface FirewallRuleInsert {
  at: number
  spec: FirewallRuleSpec
}
export interface FirewallRuleEdit {
  index?: number
  handle?: number
  chain?: string
  new_spec: FirewallRuleSpec
}
export interface FirewallRuleMove {
  from: number
  to: number
  handle?: number
  chain?: string
}

export interface FirewallProbe {
  os_id: string
  pkg_manager: string
  has_ufw: boolean
  has_nft: boolean
  has_iptables: boolean
  has_firewalld: boolean
  has_fail2ban: boolean
  has_conntrack: boolean
  can_sudo: boolean
  recommended_tool: FirewallTool
  cmd_preview_ufw: string
  cmd_preview_nft: string
  sampled_at: string
}

export interface ServicePreset {
  id: string
  name: string
  port: string
  protocol: string
  category: string
}
export interface PolicyTemplate {
  id: string
  name: string
  description?: string
  tags?: string[] | null
  default_policy?: string
  allows: FirewallRuleSpec[] | null
  high_risk: boolean
}

export type FirewallApplyKind =
  | "add"
  | "insert"
  | "delete"
  | "edit"
  | "reorder"
  | "bulk"
  | "import"
  | "template"
  | "policy"
export interface FirewallApplyRequest {
  kind: FirewallApplyKind
  spec?: FirewallRuleSpec
  insert?: FirewallRuleInsert
  edit?: FirewallRuleEdit
  move?: FirewallRuleMove
  indexes?: number[]
  template_id?: string
  format?: string
  content?: string
  default_policy?: string
  ttl_seconds?: number
  confirm?: boolean
}
export interface FirewallApplyPlan {
  commands: string[] | null
  adds: number
  deletes: number
  high_risk: boolean
  risk_reasons?: string[] | null
}
export interface FirewallArmResult {
  arm_token: string
  snapshot_id: string
  window_seconds: number
  rollback_via: string
  job_ref: string
  ssh_guard: string
  deadline: string
  high_risk: boolean
  plan?: FirewallApplyPlan
}

export interface FirewallConn {
  proto: string
  src: string
  src_port?: number
  dst: string
  dst_port?: number
  state?: string
  bytes?: number
  packets?: number
}
export interface ConntrackSnapshot {
  total: number
  truncated: boolean
  connections: FirewallConn[] | null
  sampled_at: string
}

export interface Fail2banJail {
  name: string
  filter?: string
  banned: number
  total_failed?: number
  banned_ips?: string[] | null
}
export interface Fail2banStatus {
  installed: boolean
  running: boolean
  jails: Fail2banJail[] | null
  reason?: string
  sampled_at: string
}
export interface FirewallRulesetDump {
  tool: FirewallTool
  format: string
  content: string
  sha256: string
  sampled_at: string
}
// Returned by GET /firewall/diagnose — surfaces every observation the
// gateway made when probing the node, so operators can self-serve "why
// doesn't this work" questions in the UI.
export interface FirewallDiagnostics {
  uid: number
  is_root: boolean
  sudo_available: boolean
  sudo_nopasswd_tools?: string[]
  tools_found?: string[]
  selected_tool: FirewallTool
  probe_raw: string
  last_error?: string
  elapsed_ms: number
  sampled_at: string
}

export interface DockerStatus {
  available: boolean
  version?: string
  api_version?: string
  os?: string
  reason?: string
  containers: number
  images: number
  sampled_at: string
}
export interface DockerContainer {
  id: string
  names: string
  image: string
  state: string
  status: string
  command: string
  ports: string
  created_at: string
  size_rootfs?: string
  sampled_at: string
}
export interface DockerImage {
  id: string
  repository: string
  tag: string
  digest?: string
  size: string
  created_at: string
  sampled_at: string
}
export interface DockerLogsResponse {
  container_id: string
  tail: number
  logs: string
}
export interface DockerContainerDetail {
  id: string
  name: string
  image: string
  state: string
  status: string
  created?: string
  started_at?: string
  restart_policy?: string
  restart_count: number
  ip_address?: string
  ports?: string[]
  mounts?: string[]
  env?: string[]
  networks?: string[]
  cmd?: string
  raw: string
  sampled_at: string
}
export interface DockerStats {
  id: string
  name: string
  cpu_pct: number
  mem_usage: string
  mem_pct: number
  net_io: string
  block_io: string
  pids: number
}
export interface DockerTop {
  container_id: string
  titles: string[]
  processes: string[][]
}
export interface DockerNetwork {
  id: string
  name: string
  driver: string
  scope: string
}
export interface DockerVolume {
  name: string
  driver: string
  mountpoint?: string
}
export interface DockerActionResult {
  ok: boolean
  output: string
}

// ---------------- systemd service management ----------------
export type SystemdVerb = "start" | "stop" | "restart" | "reload" | "enable" | "disable"
export interface SystemdStatus {
  available: boolean
  state: string
  version?: string
  total_units: number
  running_units: number
  failed_units: number
  reason?: string
  sampled_at: string
}
export interface SystemdUnit {
  name: string
  description: string
  load: string
  active: string
  sub: string
  enabled: string
}
export interface SystemdDetail {
  unit: SystemdUnit
  properties: Record<string, string>
  main_pid?: number
  memory_bytes?: number
  tasks_current?: number
  active_since?: string
  journal?: string
  sampled_at: string
}
export interface SystemdJournal {
  unit: string
  lines: number
  text: string
  sampled_at: string
}

// ---------------- process management ----------------
export type ProcSignal = "TERM" | "KILL" | "HUP" | "INT" | "STOP" | "CONT" | "USR1" | "USR2" | "QUIT"
export type ProcSort = "cpu" | "mem" | "rss" | "pid"
export interface ProcRow {
  pid: number
  ppid: number
  user: string
  cpu_pct: number
  mem_pct: number
  rss_kb: number
  vsz_kb: number
  threads: number
  nice: number
  state: string
  elapsed_sec: number
  comm: string
  args: string
}
export interface ProcList {
  generated_at: string
  total: number
  processes: ProcRow[]
}
export interface ProcDetail {
  pid: number
  status: Record<string, string>
  cmdline?: string
  limits?: string
  fd_count: number
  io_read_bytes?: number
  io_write_bytes?: number
  sampled_at: string
}

// ---------------- performance diagnostics ----------------
export interface PerfPressureMetric {
  avg10: number
  avg60: number
  avg300: number
}
export interface PerfPressure {
  available: boolean
  cpu_some: PerfPressureMetric
  io_some: PerfPressureMetric
  io_full: PerfPressureMetric
  mem_some: PerfPressureMetric
  mem_full: PerfPressureMetric
}
export interface PerfVMStat {
  available: boolean
  procs_r: number
  procs_b: number
  swap_in_kbs: number
  swap_out_kbs: number
  block_in_kbs: number
  block_out_kbs: number
  interrupts: number
  context_switches: number
  cpu_user: number
  cpu_system: number
  cpu_idle: number
  cpu_iowait: number
  cpu_steal: number
}
export interface PerfDisk {
  device: string
  tps: number
  read_kbs: number
  write_kbs: number
  await_ms: number
  util_pct: number
}
export interface PerfSnapshot {
  generated_at: string
  load_avg: [number, number, number]
  uptime_sec: number
  pressure: PerfPressure
  vmstat: PerfVMStat
  disks: PerfDisk[]
  sysstat_available: boolean
  dmesg_tail?: string[]
  oom_events?: string[]
  notes?: string
}
export interface PerfDmesg {
  lines: string[]
  sampled_at: string
}

// ---------------- log viewer ----------------
export interface LogFile {
  path: string
  size_kb: number
  modified?: string
}
export interface LogList {
  has_journal: boolean
  files: LogFile[]
  sampled_at: string
}
export interface LogTail {
  source: string
  ref: string
  lines: number
  text: string
  sampled_at: string
}

// ---------------- hardware ----------------
export interface HwMemModule {
  locator: string
  size: string
  type?: string
  speed?: string
  manufacturer?: string
}
export interface Hardware {
  cpu: Record<string, string>
  bios: Record<string, string>
  mem_summary: string
  mem_modules?: HwMemModule[]
  pci?: string[]
  usb?: string[]
  sensors?: string[]
  notes?: string
  sampled_at: string
}

// ---------------- kernel ----------------
export interface KSysctl {
  key: string
  value: string
}
export interface KModule {
  name: string
  size_kb: number
  used_by?: string
}
export interface KernelInfo {
  hostname: string
  kernel: string
  os: string
  timezone?: string
  sysctls: KSysctl[]
  modules: KModule[]
  limits?: string
  sampled_at: string
}

// ---------------- storage ----------------
export interface StBlockDevice {
  name: string
  type: string
  size: string
  fstype?: string
  mountpoint?: string
  model?: string
  children?: StBlockDevice[]
}
export interface StFilesystem {
  source: string
  fstype?: string
  mount: string
  size_kb: number
  used_kb: number
  avail_kb: number
  use_pct: number
  inode_pct: number
}
export interface StFstabEntry {
  spec: string
  mount: string
  fstype: string
  options: string
}
export interface StSmart {
  device: string
  health: string
}
export interface StorageInfo {
  devices: StBlockDevice[]
  filesystems: StFilesystem[]
  fstab?: StFstabEntry[]
  smart?: StSmart[]
  lvm?: string
  sampled_at: string
}

// ---------------- network tools ----------------
export type NetDiagTool = "ping" | "traceroute" | "dig" | "curl" | "mtr"
export interface NetIfaceInfo {
  name: string
  mac?: string
  state: string
  mtu?: number
  ipv4?: string[]
  ipv6?: string[]
}
export interface NetRoute {
  dst: string
  via?: string
  dev?: string
  proto?: string
  src?: string
}
export interface NetConn {
  proto: string
  state: string
  local: string
  peer: string
  process?: string
}
export interface NetInfo {
  ifaces: NetIfaceInfo[]
  routes: NetRoute[]
  conns: NetConn[]
  sampled_at: string
}
export interface NetDiagResult {
  tool: string
  target: string
  output: string
  sampled_at: string
}

// ---------------- cron / scheduled tasks ----------------
export interface CronEntry {
  index: number
  schedule: string
  command: string
  raw: string
}
export interface CronTimer {
  unit: string
  next?: string
  left?: string
  activates?: string
  enabled?: string
}
export interface CronInfo {
  user_cron: CronEntry[]
  system_cron?: string[]
  timers?: CronTimer[]
  has_crontab: boolean
  sampled_at: string
}

// ---------------- packages ----------------
export type PkgVerb = "install" | "remove" | "upgrade" | "upgrade-all" | "update" | "autoremove" | "clean"
export interface PkgInfo {
  name: string
  version?: string
  installed: boolean
  size?: string
  summary?: string
  homepage?: string
  section?: string
  depends?: string[]
  raw: string
}
export interface PkgStatus {
  manager: string
  available: boolean
  installed_count: number
  upgradable_count: number
  security_count: number
  reason?: string
  sampled_at: string
}
export interface PkgUpdate {
  name: string
  current?: string
  candidate?: string
  security?: boolean
}
export interface PkgSearchItem {
  name: string
  version?: string
  installed: boolean
  summary?: string
}
export interface PkgActionResult {
  ok: boolean
  output: string
}

// ---------------- local users ----------------
export interface SysUser {
  name: string
  uid: number
  gid: number
  gecos?: string
  home?: string
  shell?: string
  system: boolean
}
export interface SysGroup {
  name: string
  gid: number
  members?: string[]
}
export interface SysLoginSession {
  user: string
  tty: string
  from?: string
  login?: string
}
export interface SysLoginHistory {
  user: string
  from?: string
  when?: string
  failed?: boolean
}
export interface SysUserInfo {
  users: SysUser[]
  groups: SysGroup[]
  online: SysLoginSession[]
  recent?: SysLoginHistory[]
  sudoers?: string[]
  sampled_at: string
}

// ---------------- security posture ----------------
export type SecStatus = "ok" | "warn" | "danger" | "info" | "unknown"
export interface SecCheck {
  id: string
  category: string
  title: string
  status: SecStatus
  detail?: string
  items?: string[]
  fix?: string
  applicable: boolean
}
export interface SecReport {
  score: number
  checks: SecCheck[]
  sampled_at: string
}

export interface AssetGrant {
  id: number
  grantee_type: "user" | "role" | "group" | "department"
  grantee_id: number
  subject_type: "node" | "group" | "tag" | "department" | "all"
  subject_id: number
  actions: string
  valid_from?: string
  valid_to?: string
  source?: string
}

export type GranteeKind = "user" | "role" | "group" | "department"
// "catalog" only ever appears as the `via` label on SubjectAccessRow (access
// derived from a 授权目录); it is never a grant subject the picker can choose.
export type SubjectKind = "node" | "group" | "tag" | "all" | "catalog"

export interface GranteeRef {
  type: GranteeKind
  id: number
}

// 按人看：某主体（穿透用户组/角色/部门后）实际可访问的资产。
export interface NodeAccess {
  node_id: number
  actions: string[]
  sources: GranteeRef[]
  // 该节点访问的最晚到期时间（贡献授权中最晚者；缺省=永久）。
  valid_to?: string | null
  // 该节点所属的资产组 ID，用于把扁平可达集挂回资产组层级树。
  group_ids?: number[]
}
export interface AccessExplanation {
  all_actions: string[]
  all_sources: GranteeRef[]
  // “全部资产”授权的到期（缺省=永久）。
  all_valid_to?: string | null
  nodes: NodeAccess[]
}

// 按资产看：某节点谁能访问、经由什么、何时到期。
export interface SubjectAccessRow {
  grantee_type: GranteeKind
  grantee_id: number
  actions: string[]
  via: SubjectKind
  grant_id: number
  valid_to?: string | null
}

// ----- 授权目录 (per-object authorisation tree) -----
// Each authorisation object (user / group / department) owns a folder tree of
// assets with inline permissions; editing it IS authorising that object, and
// members inherit their group / department tree. Resolved into the same access
// set as AssetGrant on the backend.
export interface AccessFolder {
  id: number
  owner_type: GranteeKind
  owner_id: number
  name: string
  parent_id?: number | null
  path: string
  icon?: string
  sort_order?: number
  actions?: string // csv, "" = inherit parent chain
  valid_from?: string | null
  valid_to?: string | null
}
export interface AccessItem {
  id: number
  owner_type: GranteeKind
  owner_id: number
  folder_id: number
  node_id: number
  actions?: string // csv, "" = inherit folder
  valid_from?: string | null
  valid_to?: string | null
  sort_order?: number
}
// Admin editor payload (GET /access-tree?owner_type=&owner_id=).
export interface AccessTreeData {
  folders: AccessFolder[]
  items: AccessItem[]
}
// A named, reusable directory blueprint (cloned onto an object on demand).
export interface AccessTemplate {
  id: number
  name: string
  description?: string
  created_by?: number
  created_at?: string
}
// Workspace "我的目录" payload (GET /me/directory) — merged across the user's
// own / inherited trees, filtered to connectable nodes and pruned server-side.
export interface MyDirFolder {
  id: number
  parent_id?: number | null
  name: string
  path: string
  icon?: string
  sort_order?: number
}
export interface MyDirItem {
  folder_id: number
  node_id: number
  sort_order?: number
}
export interface MyDirectory {
  folders: MyDirFolder[]
  items: MyDirItem[]
}

export interface LoginHistory {
  id: number
  username: string
  ip: string
  user_agent: string
  result: string
  auth_method: string
  mfa_method: string
  anomaly: boolean
  reason?: string
  created_at: string
}

export interface MFADevice {
  id: number
  user_id: number
  type: "totp" | "email"
  display_name: string
  enabled: boolean
  last_used_at?: string | null
  created_at: string
}

export interface Passkey {
  id: number
  user_id: number
  display_name: string
  aaguid?: string
  transports?: string
  sign_count: number
  created_at: string
  last_used_at?: string | null
}

export interface OIDCClient {
  id: number
  name: string
  display_name?: string
  issuer: string
  client_id: string
  redirect_uri: string
  scopes: string
  username_claim?: string
  email_claim?: string
  auto_create_user?: boolean
  default_role?: string
  enabled: boolean
}

// ----- AI subsystem -----

export type ProviderKind = "openai" | "anthropic" | "openai_compatible" | "gemini"
export type PermissionMode = "plan" | "normal" | "bypass"
export type AgentScope = "global" | "personal"

export interface AIModelPricing {
  in_per_mtok?: number
  out_per_mtok?: number
  cache_read_per_mtok?: number
  cache_write_per_mtok?: number
}

// AIModel mirrors the backend provider.ModelInfo (the persisted curated-model
// shape + live-discovery result). Capabilities + pricing drive the model editor.
export interface AIModel {
  id: string
  label?: string
  context_window?: number
  max_output?: number
  tools?: boolean
  vision?: boolean
  reasoning?: boolean
  caching?: boolean
  pricing?: AIModelPricing
}

export type ProviderHealthState = "online" | "degraded" | "offline" | "unknown"

// ProviderHealth is one entry of the live health snapshot (keyed by provider id),
// with the rate-limit budget folded in by the backend.
export interface ProviderHealth {
  provider_id: number
  name?: string
  kind?: string
  state: ProviderHealthState
  latency_ms?: number
  model_count?: number
  sample_model?: string
  last_error?: string
  checked_at?: string
  req_limit?: number
  req_remaining?: number
  tok_limit?: number
  tok_remaining?: number
}

// ProviderExtra is the redacted provider-specific config (secrets collapsed to
// header_keys / booleans by the backend).
export interface ProviderExtra {
  azure_deployment?: string
  azure_api_version?: string
  azure_endpoint?: string
  bedrock_region?: string
  org_id?: string
  header_keys?: string[]
}

export interface ProviderPresetExtraField {
  key: string
  label: string
  placeholder?: string
  required?: boolean
}

// AIProviderPreset is one entry of the static provider catalog (gallery + wizard).
export interface AIProviderPreset {
  slug: string
  name: string
  kind: ProviderKind
  category: "international" | "domestic" | "local"
  base_url?: string
  icon?: string
  key_help?: string
  docs_url?: string
  needs_base_url?: boolean
  extra_fields?: ProviderPresetExtraField[]
  models?: AIModel[]
}

export interface AIProvider {
  id: number
  name: string
  kind: ProviderKind
  display_name?: string
  base_url?: string
  default_model?: string
  is_global: boolean
  owner_id?: number | null
  enabled: boolean
  api_key_last4?: string
  // Extended fields (round-tripped by the provider handler; all optional so older
  // call sites stay valid).
  proxy_url?: string
  rate_limit_rpm?: number
  rate_limit_tpm?: number
  models?: AIModel[]
  extra?: ProviderExtra
  health?: ProviderHealth
  created_at?: string
  updated_at?: string
}

export interface AIAgent {
  id: number
  name: string
  description?: string
  // Unified icon token for the agent avatar (lucide:* / simple:* / emoji:* /
  // text:*). Empty → initials avatar.
  icon?: string
  scope: AgentScope
  owner_id?: number | null
  system_prompt: string
  default_provider_id?: number | null
  default_model?: string
  allowed_tools: string
  permission_mode: PermissionMode
  max_iterations: number
  temperature?: number
  top_p?: number
  is_sub_agent?: boolean
  invocation_hint?: string
  tags?: string
  // JSON-encoded number[] of attached knowledge-base ids (same encoding as
  // allowed_tools). Gates the knowledge_search tool.
  knowledge_base_ids?: string
  // Cross-session long-term memory recall + the remember tool.
  memory_enabled?: boolean
  enabled: boolean
}

// ----- AI knowledge base (RAG) + long-term memory -----

export type KBIngestStatus = "pending" | "chunking" | "embedding" | "ready" | "failed"

export interface AIKnowledgeBase {
  id: number
  name: string
  description?: string
  scope: AgentScope
  owner_id?: number | null
  embedding_model?: string
  embedding_dim?: number
  backend?: string // "pgvector" | "fallback"
  document_count: number
  chunk_count: number
  enabled: boolean
  created_at: string
  updated_at: string
}

export interface AIDocument {
  id: number
  knowledge_base_id: number
  title: string
  source?: string
  mime?: string
  status: KBIngestStatus
  error?: string
  chunk_count: number
  size: number
  created_at: string
  updated_at: string
}

export interface AIMemory {
  id: number
  user_id: number
  agent_id: number
  kind: "fact" | "preference" | "resolution"
  content: string
  source_conversation_id?: string
  salience: number
  last_used_at?: string | null
  created_at: string
  updated_at: string
}

export interface AIConversation {
  id: string
  user_id: number
  agent_id: number
  title: string
  provider_id: number
  model: string
  permission_mode: PermissionMode
  total_input_tokens?: number
  total_output_tokens?: number
  total_cache_read_tokens?: number
  total_cache_write_tokens?: number
  total_cost_micros?: number
  message_count: number
  status: "active" | "running" | "idle" | "archived"
  archived?: boolean
  pinned?: boolean
  // Per-conversation override of model parameters; null falls back to the
  // owning agent's default.
  temperature?: number | null
  top_p?: number | null
  max_tokens?: number | null
  // Extended-thinking budget (tokens); null/0 = off.
  thinking_budget?: number | null
  created_at: string
  updated_at: string
}

export interface AIMessage {
  id: number
  conversation_id: string
  parent_id?: number | null  // branch DAG link (null = linear / root)
  role: "system" | "user" | "assistant" | "tool"
  content: string  // JSON: ContentPart[]
  reasoning?: string  // persisted extended-thinking trace (assistant turns)
  tool_call_id?: string
  tool_calls?: string  // JSON: ToolCall[]
  input_tokens?: number
  output_tokens?: number
  finish_reason?: string
  created_at: string
}

export interface AITask {
  id: number
  conversation_id: string
  ordinal: number
  title: string
  status: "pending" | "active" | "done" | "skipped" | "failed"
  detail?: string
  created_at?: string
  updated_at?: string
}

export interface AIToolInvocation {
  id: string
  conversation_id: string
  message_id: number
  tool_call_id?: string
  tool_name: string
  input: string
  permission_mode: PermissionMode
  status: "pending" | "approved" | "rejected" | "running" | "succeeded" | "failed" | "dry_run"
  approved_by?: number | null
  approved_at?: string | null
  output?: string
  output_truncated?: boolean
  duration_ms?: number
  error?: string
  created_at: string
  completed_at?: string | null
}

export interface AITool {
  name: string
  description: string
  danger: "low" | "medium" | "high"
  required_perm?: string
  schema: Record<string, unknown>
}

export interface TokenPair {
  access_token: string
  refresh_token?: string
  expires_at: string
}

// ----- Anonymous Docker sandbox -----
// The honest spec of the throwaway container an anonymous token buys: how long
// it lives and the walls it runs behind. Rendered as the countdown + limit
// chips on the public sandbox page.
export interface SandboxSpec {
  ttl_seconds: number
  image: string
  memory_mb: number
  cpu: number
  network: string
  shell: string[]
}

// POST /auth/anonymous response: a token pair (flattened) plus the sandbox spec.
export interface AnonymousSession extends TokenPair {
  sandbox: SandboxSpec
}

// ----- Phase 11 — terminal personalization -----

export interface Snippet {
  id: number
  user_id: number
  name: string
  description?: string
  body: string
  tags?: string
  pinned: boolean
  usage_count: number
  last_used_at?: string | null
  created_at: string
  updated_at: string
  variables?: string[] // server-extracted {{var}} names
}

export interface CommandHistoryRow {
  id: number
  user_id: number
  node_id?: number | null
  session_id?: string
  command: string
  exit_code: number
  duration_ms: number
  working_dir?: string
  created_at: string
}

export interface TerminalProfileRow {
  user_id: number
  body: string
  history_enabled: boolean
  updated_at?: string
}


// ---------------- Phase 15/16 — Approval Service ----------------

export type ApprovalBusinessType =
  | "asset_access"
  | "credential_use"
  | "command_exec"
  | "sql_exec"
  | "file_transfer"
  | "session_extend"
  | "session_elevate"
  | "break_glass"
  | "vendor_access"
  | "audit_view"

export type ApprovalRiskLevel = "low" | "medium" | "high" | "critical"

export type ApprovalRequestStatus =
  | "pending"
  | "approved"
  | "auto_approved"
  | "rejected"
  | "cancelled"
  | "expired"

export type ApprovalTaskState =
  | "pending"
  | "approved"
  | "rejected"
  | "delegated"
  | "expired"
  | "skipped"

export type ApprovalStageMode = "all" | "any" | "quorum"

export type ApprovalGrantStatus = "active" | "expired" | "revoked" | "used_up"

export interface ApprovalRequest {
  id: string
  business_type: ApprovalBusinessType
  title: string
  reason: string
  requester_id: number
  requester_name: string
  resource_type?: string
  resource_id?: string
  payload?: string
  template_id?: number | null
  risk_level: ApprovalRiskLevel
  status: ApprovalRequestStatus
  window_start: string
  window_end: string
  effective_window_end?: string | null
  current_stage: number
  total_stages: number
  version: number
  created_at: string
  updated_at: string
  resolved_at?: string | null
  client_ip?: string
}

export interface ApprovalTask {
  id: number
  request_id: string
  stage: number
  stage_mode: ApprovalStageMode
  quorum_n?: number
  approver_id: number
  approver_role?: string
  state: ApprovalTaskState
  comment?: string
  delegated_to?: number | null
  expires_at?: string | null
  decided_at?: string | null
  created_at: string
}

export interface ApprovalEvent {
  id: number
  request_id: string
  kind: string
  actor_id?: number
  actor_name?: string
  payload?: string
  prev_hash: string
  hash: string
  signature?: string
  kms_provider_id?: number | null
  created_at: string
}

export interface ApprovalGrant {
  id: string
  request_id: string
  business_type: ApprovalBusinessType
  beneficiary_id: number
  resource_type: string
  resource_id: string
  actions: string
  max_uses: number
  used_count: number
  not_before: string
  not_after: string
  status: ApprovalGrantStatus
  revoked_by?: number | null
  revoked_at?: string | null
  revoke_reason?: string
  created_at: string
}

export interface ApprovalRequestDetail {
  request: ApprovalRequest
  tasks: ApprovalTask[]
  events: ApprovalEvent[]
  grant?: ApprovalGrant | null
}

export interface ChainVerifyResult {
  request_id: string
  total_events: number
  ok: boolean
  first_bad_event_id?: number
  reason?: string
}

// Workspace connection gate: whether approval is required, already satisfied,
// and any in-flight request to resume.
export interface ApprovalPreflight {
  required: boolean
  allowed: boolean
  grant_id?: string
  expires_at?: string
  pending_request_id?: string
  reason?: string
}

// Realtime SSE envelope from /approvals/stream and /approvals/:id/stream.
export interface ApprovalStreamEvent {
  request_id: string
  requester_id: number
  kind: string
  status: ApprovalRequestStatus
  title: string
  business_type: ApprovalBusinessType
  resource_type: string
  resource_id: string
  risk_level: ApprovalRiskLevel
  current_stage: number
  total_stages: number
  grant_id?: string
  expires_at?: string
  at: string
}

// In-app notification (notification center). Approval events are the first
// source; the shape is deliberately generic so future sources can reuse it.
export interface AppNotification {
  id: string
  kind: string
  title: string
  body?: string
  href?: string
  requestId?: string
  status?: ApprovalRequestStatus
  at: string
  read: boolean
}

export interface ApprovalTemplate {
  id: number
  name: string
  description: string
  business_type: ApprovalBusinessType
  priority: number
  enabled: boolean
  is_system: boolean
  selector: string
  stages: string
  risk_rule?: string
  auto_approve?: string
  max_duration_sec: number
  default_timeout_sec: number
  created_at: string
  updated_at: string
}

export interface ApprovalSubscription {
  id: number
  name: string
  channel: string
  target: string
  secret?: string
  business_type?: ApprovalBusinessType
  event_mask?: string
  enabled: boolean
  created_at: string
  updated_at: string
}

// Per-user workspace summary strip.
export interface ApprovalOverview {
  pending_for_me: number
  my_open_requests: number
  decided_today: number
  active_grants: number
}

// Lightweight parent-request context carried on each inbox item.
export interface ApprovalRequestSummary {
  id: string
  business_type: ApprovalBusinessType
  title: string
  reason: string
  requester_id: number
  requester_name: string
  resource_type?: string
  resource_id?: string
  risk_level: ApprovalRiskLevel
  status: ApprovalRequestStatus
  current_stage: number
  total_stages: number
  window_end: string
  created_at: string
}

// Approver inbox row: pending task + its parent request, joined server-side.
export interface ApprovalInboxItem {
  task: ApprovalTask
  request: ApprovalRequestSummary
}

// Grant joined with originating-request + beneficiary context for the
// "我的授权" view and the governance console.
export interface ApprovalGrantRow extends ApprovalGrant {
  request_title: string
  request_reason: string
  beneficiary_name: string
}

// Admin governance snapshot.
export interface ApprovalStats {
  status_counts: Record<string, number>
  risk_counts: Record<string, number>
  business_counts: Record<string, number>
  pending_total: number
  created_today: number
  resolved_today: number
  active_grants: number
  avg_decision_min: number
}

export interface ApprovalBulkDecideResult {
  results: { task_id: number; ok: boolean; error?: string }[]
  ok_count: number
  total: number
}

// ---------------- Phase 17 — DB Studio ----------------

export interface DBColumnMeta {
  name: string
  type: string
  nullable?: boolean
}

export interface DBQueryResult {
  columns: DBColumnMeta[]
  rows: unknown[][]
  truncated: boolean
  elapsed: number  // nanoseconds (Go time.Duration JSON)
  row_count: number
}

export interface DBExecResult {
  affected: number
  last_insert_id?: number
  elapsed: number
}

// Phase 30f — per-column summary for the column-header popover.
export interface DBColumnValueFreq {
  value: string
  frequency: number
}
export interface DBColumnStats {
  column: string
  distinct_count: number
  null_count: number
  total_count: number
  min_value?: string
  max_value?: string
  top_values: DBColumnValueFreq[]
}

// Phase 30c — one trigger row per table-attached trigger. Empty array
// when the table has none. Engines without programmable triggers
// (StarRocks / Doris) always return [].
export interface DBTriggerInfo {
  name: string
  timing: string  // BEFORE / AFTER / INSTEAD OF (PG); or MySQL ACTION_TIMING
  event: string   // INSERT / UPDATE / DELETE / TRUNCATE
  statement: string
  enabled: boolean
}

// Phase 30 — per-database health snapshot for the DB Studio status
// bar. Each engine fills the fields it can expose; missing values
// come back as 0 / "".
export interface DBDatabaseStats {
  size_bytes: number
  table_count: number
  connections: number
  version: string
  uptime_seconds: number
}

// Phase 30 — per-statement breakdown from POST /db/query-multi. Each
// statement gets one entry in submission order; the first failure
// halts the run (later statements aren't attempted).
export interface DBMultiQueryResult {
  index: number
  statement: string
  // "query" | "exec" | "error" — discriminator for which sibling field
  // is populated.
  kind: "query" | "exec" | "error"
  result?: DBQueryResult
  exec?: DBExecResult
  error?: string
  elapsed: number
}

export interface DBTableInfo {
  schema: string
  name: string
  kind: "table" | "view" | "matview"
}

export interface DBDatabaseInfo {
  name: string
  tables: DBTableInfo[]
}

export interface DBSchemaInfo {
  current_database: string
  databases: DBDatabaseInfo[]
}

export interface DBColumnInfo {
  name: string
  type: string
  nullable: boolean
  is_primary_key: boolean
  default_value?: string
  ordinal_position: number
}

export interface DBIndexInfo {
  name: string
  is_primary: boolean
  is_unique: boolean
  columns: string[]
}

// Phase 19 — Structure tab + row CRUD

export interface DBForeignKeyInfo {
  direction: "out" | "in"
  name: string
  from_schema: string
  from_table: string
  from_columns: string[]
  to_schema: string
  to_table: string
  to_columns: string[]
  on_update: string
  on_delete: string
}

export interface DBTableStats {
  rows_approx: number
  total_bytes: number
  data_bytes: number
  index_bytes: number
  engine?: string
}

export interface DBRowKey {
  columns: string[]
  values: unknown[]
}

// Phase 20 — running queries panel
export interface DBProcessInfo {
  pid: number
  username: string
  client_addr?: string
  database?: string
  state?: string
  wait_event?: string
  application?: string
  query_start?: string
  elapsed_sec?: number
  query?: string
}

// ----- Phase 12 — SSH power -----

export interface SSHKey {
  id: number
  user_id: number
  name: string
  type: "ed25519" | "rsa-2048" | "rsa-3072" | "rsa-4096" | string
  public: string
  fingerprint: string
  created_at: string
  updated_at: string
  last_used_at?: string | null
}

export interface KnownHost {
  id: number
  user_id: number
  node_id?: number | null
  host_addr: string
  host_key_type: string
  fingerprint: string
  status: "trusted" | "revoked"
  accepted_at: string
  last_seen_at?: string | null
  notes?: string
}

export interface BulkRun {
  id: number
  user_id: number
  title: string
  command: string
  node_ids_json: string
  node_count: number
  ok_count: number
  fail_count: number
  duration_ms: number
  summary?: string
  created_at: string
}

export interface BulkRunResult {
  id: number
  run_id: number
  node_id: number
  node_name: string
  stdout: string
  stderr: string
  exit_code: number
  duration_ms: number
  error?: string
  created_at: string
}

// ---------- System settings (super-admin runtime configuration) ----------
// Mirrors internal/settings: a schema-driven config editor whose fields the UI
// renders from metadata rather than hardcoding each knob.

export type SettingFieldType =
  | "bool"
  | "int"
  | "float"
  | "string"
  | "text"
  | "duration"
  | "enum"
  | "stringlist"
  | "stringmap"
  | "secret"
  | "color"

// Per-user anti-leak watermark payload returned by GET /me/watermark. Identity
// and IP are resolved server-side (email/phone masked); the {date}/{time}/
// {datetime} tokens inside `text` are left for the client to fill live.
export interface WatermarkRuntime {
  enabled: boolean
  scope?: "all" | "session"
  text?: string
  style?: {
    opacity: number
    fontSize: number
    color: string
    rotation: number
    gapX: number
    gapY: number
  }
  blind?: { enabled: boolean; text: string }
  features?: {
    antiTamper: boolean
    hardened: boolean
    liveClock: boolean
    refreshSec: number
    // When true, the client fills {asset}/{host}/{session} inside a live
    // terminal/desktop session; plain pages always clear them.
    sessionVars?: boolean
  }
}

// Session-scoped values the watermark engine fills client-side (analogous to
// the {date}/{time} clock tokens). Only present inside a live connection; a
// plain page passes none, so {asset}/{host}/{session} resolve to empty and
// their lines are trimmed away.
export interface WatermarkSessionContext {
  asset?: string
  host?: string
  session?: string
}

export interface SettingEnumOption {
  value: string
  label: string
  help?: string
}

export interface SettingField {
  key: string
  group: string
  type: SettingFieldType
  label: string
  help?: string
  unit?: string
  /** true = applies without a restart; false = "重启后生效". */
  live: boolean
  advanced: boolean
  /** true = currently has a DB override (vs. the built-in default). */
  overridden: boolean
  placeholder?: string
  integration?: string
  depends_on?: string
  /** "*" means "the dependency is non-empty"; otherwise an exact match. */
  depends_value?: string
  enum?: SettingEnumOption[]
  min?: number
  max?: number
  step?: number
  /** Present for every non-secret field. */
  value?: unknown
  /** Present only for secret fields — whether one is configured. */
  secret_set?: boolean
}

export interface SettingsGroup {
  id: string
  title: string
  subtitle?: string
  icon: string
  order: number
  integrations?: string[]
}

export type IntegrationState = "disabled" | "unconfigured" | "configured" | "healthy" | "error"

export interface IntegrationStatus {
  id: string
  title: string
  group: string
  state: IntegrationState
  summary?: string
  detail?: string
  latency_ms?: number
  tested_at?: string
}

export interface SettingsSchema {
  ok: boolean
  groups: SettingsGroup[]
  fields: SettingField[]
  integrations: IntegrationStatus[]
}

export interface SettingsAudit {
  id: number
  key: string
  group: string
  old_value: string
  new_value: string
  actor_id: number
  actor_name: string
  created_at: string
}

// ----- Break-glass (应急访问) -----

export type BreakGlassMode = "pre_approved" | "fail_open"
export type BreakGlassStatus =
  | "pending"
  | "active"
  | "expired"
  | "revoked"
  | "rejected"
  | "under_review"
  | "closed"
export type BreakGlassScopeType = "all" | "tag" | "node"
export type BreakGlassReviewVerdict = "justified" | "unjustified" | "inconclusive"

export interface BreakGlassPolicy {
  id: number
  name: string
  description?: string
  enabled: boolean
  scope_type: BreakGlassScopeType
  scope_id?: number | null
  max_duration_sec: number
  require_incident_ref: boolean
  require_dual_auth: boolean
  allow_fail_open: boolean
  require_post_use_review: boolean
  created_by?: number
  created_at: string
  updated_at: string
}

export interface BreakGlassActivation {
  id: string
  policy_id?: number | null
  policy_name?: string
  requester_id: number
  requester_name: string
  resource_type: string
  resource_id: string
  resource_name?: string
  justification: string
  incident_ref?: string
  mode: BreakGlassMode
  status: BreakGlassStatus
  approval_request_id?: string
  approval_grant_id?: string
  asset_grant_id?: number | null
  activated_at?: string | null
  not_after?: string | null
  revoked_by?: number | null
  revoked_by_name?: string
  revoked_at?: string | null
  revoke_reason?: string
  review_required: boolean
  reviewer_id?: number | null
  reviewer_name?: string
  reviewed_at?: string | null
  review_verdict?: BreakGlassReviewVerdict
  review_comment?: string
  client_ip?: string
  created_at: string
  updated_at: string
}

export interface BreakGlassStats {
  active: number
  pending: number
  under_review: number
  total: number
  today: number
  revoked_total: number
  fail_open_total: number
}
