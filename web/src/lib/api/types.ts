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
  department_id?: number | null
  is_admin?: boolean
  disabled?: boolean
  mfa_enforced?: boolean
  passkey_only?: boolean
  last_login_at?: string | null
  last_login_ip?: string
  created_at?: string
  updated_at?: string
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
  region?: string
  description?: string
  disabled?: boolean
  created_at?: string
  updated_at?: string
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

  enable_remote_fx?: boolean
  enable_nscodec?: boolean
  enable_h264?: boolean
  enable_graphics_pipeline?: boolean

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
}

// ProtoOptionsEnvelope is the structured shape persisted as a JSON string
// in node.proto_options. Each protocol owns its own sub-object so future
// VNC / SSH / DB tuning can land without colliding with RDP.
export interface ProtoOptionsEnvelope {
  rdp?: RdpProtoOptions
}

export interface Credential {
  id: number
  name: string
  kind: "password" | "private_key" | "agent"
  username: string
  created_at?: string
  updated_at?: string
}

export type ProxyKind = "direct" | "socks5" | "bastion" | "http_connect"

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
  created_at?: string
  updated_at?: string
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

export interface Session {
  id: string
  kind: "interactive" | "anonymous" | "sftp" | "graphical" | "tcp_forward"
  user_id: number
  username: string
  node_id?: number | null
  node_name?: string
  client_ip?: string
  started_at: string
  ended_at?: string | null
  status: "active" | "closed" | "terminated" | "errored"
  recording_path?: string
  recording_type?: "asciicast" | "guac" | ""
  bytes_in?: number
  bytes_out?: number
  reason?: string
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
  status: "active" | "expired" | "closed"
  bytes_in?: number
  bytes_out?: number
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
  parent_id?: number | null
  path: string
  order_idx?: number
}

export interface UserGroup {
  id: number
  name: string
  description?: string
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

export interface AssetTag {
  id: number
  name: string
  color?: string
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
  message_count: number
  status: "active" | "running" | "idle" | "archived"
  archived?: boolean
  pinned?: boolean
  // Per-conversation override of model parameters; null falls back to the
  // owning agent's default.
  temperature?: number | null
  top_p?: number | null
  max_tokens?: number | null
  created_at: string
  updated_at: string
}

export interface AIMessage {
  id: number
  conversation_id: string
  role: "system" | "user" | "assistant" | "tool"
  content: string  // JSON: ContentPart[]
  tool_call_id?: string
  tool_calls?: string  // JSON: ToolCall[]
  input_tokens?: number
  output_tokens?: number
  finish_reason?: string
  created_at: string
}

export interface AIToolInvocation {
  id: string
  conversation_id: string
  message_id: number
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
