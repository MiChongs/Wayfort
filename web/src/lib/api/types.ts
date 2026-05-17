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
  proto_options?: string
  tags?: string
  region?: string
  description?: string
  disabled?: boolean
  created_at?: string
  updated_at?: string
}

export interface Credential {
  id: number
  name: string
  kind: "password" | "private_key" | "agent"
  username: string
  created_at?: string
  updated_at?: string
}

export interface Proxy {
  id: number
  name: string
  kind: "direct" | "socks5" | "bastion" | "http_connect"
  host: string
  port: number
  credential_id?: number | null
  created_at?: string
  updated_at?: string
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
}

export interface AssetTag {
  id: number
  name: string
  color?: string
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
