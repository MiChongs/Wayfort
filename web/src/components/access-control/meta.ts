import type { ComponentType } from "react"
import { Cable, EyeOff, Gavel, LogIn, Terminal } from "lucide-react"
import type { AccessRuleAction, AccessRuleKind, EditionFeature } from "@/lib/api/types"

type Icon = ComponentType<{ className?: string }>

export type KindMeta = {
  title: string
  description: string // page subtitle
  sheetHint: string // friendly one-liner shown inside the editor sheet
  icon: Icon
  feature?: EditionFeature // X-Pack kinds; undefined = Community
}

export const KIND_META: Record<AccessRuleKind, KindMeta> = {
  command_filter: {
    title: "命令过滤",
    icon: Terminal,
    description: "对会话中执行的命令按 用户 / 资产 / 账号 匹配并执行动作(拦截 / 复核 / 告警)。",
    sheetHint: "匹配会话中执行的命令，命中后按动作拦截、复核或告警。",
  },
  user_login: {
    title: "用户登录",
    icon: LogIn,
    description: "按用户属性、登录 IP、时段限制登录，可拒绝 / 二次复核 / 通知。",
    sheetHint: "按用户、来源 IP、时段限制登录，可拒绝、强制 MFA 或通知。",
  },
  asset_connection_review: {
    title: "资产连接复核",
    icon: Gavel,
    description: "对资产连接进行二次复核，经审批人通过后方可连接。",
    sheetHint: "满足条件的资产连接，需经审批人复核后才能建立。",
    feature: "connection_review",
  },
  data_masking: {
    title: "数据脱敏",
    icon: EyeOff,
    description: "数据库查询结果按列脱敏遮盖敏感数据。",
    sheetHint: "对数据库查询结果中的敏感列进行遮盖，保护明文数据。",
    feature: "data_masking",
  },
  connection_method: {
    title: "连接方式",
    icon: Cable,
    description: "控制用户可使用的连接方式(SSH / RDP / SFTP / 数据库等)。",
    sheetHint: "控制用户可使用哪些方式（SSH / RDP / …）连接资产。",
    feature: "connection_method",
  },
}

// ACTION_META drives the rule-list table badge.
export const ACTION_META: Record<AccessRuleAction, { label: string; variant: "soft" | "success" | "warning" | "destructive" }> = {
  accept: { label: "接受", variant: "success" },
  deny: { label: "拒绝", variant: "destructive" },
  review: { label: "复核", variant: "warning" },
  notify: { label: "通知", variant: "soft" },
  alert: { label: "告警", variant: "warning" },
}

// ACTIONS_BY_KIND tailors the action choices + their plain-language effect per
// rule kind, so the editor only offers actions that make sense for that kind.
// data_masking has no action selector — a matched rule simply masks per its spec.
export const ACTIONS_BY_KIND: Record<AccessRuleKind, { value: AccessRuleAction; label: string; hint: string }[]> = {
  command_filter: [
    { value: "deny", label: "拦截", hint: "匹配的命令被拦截并记录(input-side 为威慑 + 审计)。" },
    { value: "review", label: "复核", hint: "匹配的命令提交审批复核。" },
    { value: "alert", label: "告警", hint: "放行，但向安全团队发送告警。" },
    { value: "notify", label: "通知", hint: "放行并发送通知。" },
    { value: "accept", label: "放行", hint: "显式放行，不再匹配后续规则。" },
  ],
  user_login: [
    { value: "deny", label: "拒绝登录", hint: "匹配的登录将被拒绝。" },
    { value: "review", label: "需审批", hint: "匹配的登录需管理员审批后放行。" },
    { value: "notify", label: "通知", hint: "允许登录并发送通知。" },
    { value: "accept", label: "允许登录", hint: "显式允许，豁免后续规则。" },
  ],
  asset_connection_review: [
    { value: "review", label: "需复核", hint: "连接需经审批人复核后建立。" },
    { value: "deny", label: "拒绝连接", hint: "直接拒绝匹配的连接。" },
    { value: "accept", label: "豁免", hint: "直接放行，跳过复核(白名单)。" },
  ],
  connection_method: [
    { value: "deny", label: "禁止", hint: "禁止使用下方选中的连接方式。" },
    { value: "accept", label: "允许", hint: "显式允许下方选中的连接方式。" },
  ],
  data_masking: [],
}

// defaultActionFor picks the most common action for a new rule of each kind.
export function defaultActionFor(kind: AccessRuleKind): AccessRuleAction {
  switch (kind) {
    case "asset_connection_review":
      return "review"
    case "data_masking":
      return "accept"
    default:
      return "deny"
  }
}
