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
  policy?: string
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
  raw: string
}
export interface FirewallRuleSpec {
  action: "ALLOW" | "DENY" | "REJECT"
  direction?: "in" | "out"
  protocol?: "tcp" | "udp"
  port: string
  source?: string
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
export type SubjectKind = "node" | "group" | "tag" | "all"

export interface GranteeRef {
  type: GranteeKind
  id: number
}

// 按人看：某主体（穿透用户组/角色/部门后）实际可访问的资产。
export interface NodeAccess {
  node_id: number
  actions: string[]
  sources: GranteeRef[]
}
export interface AccessExplanation {
  all_actions: string[]
  all_sources: GranteeRef[]
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
  enabled: boolean
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
