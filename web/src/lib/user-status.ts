// 用户「综合状态」的单一事实来源 —— 把 disabled / 锁定 / 过期 / 停用 / 离职 / 在职
// 归一成一个标签 + 配色，列表与详情共用，保证状态展示处处一致。配色走 DESIGN.md
// 暖语义色（绿=在职、琥珀=需注意、砖红=禁用、灰=离职）。

export type UserStatusMeta = {
  key: "disabled" | "departed" | "suspended" | "expired" | "locked" | "active"
  label: string
  /** 圆角徽章用：背景 + 文字 class。 */
  chip: string
  /** 小圆点用：背景 class。 */
  dot: string
}

export function statusMeta(u: {
  disabled?: boolean
  status?: string
  expires_at?: string | null
  locked_until?: string | null
}): UserStatusMeta {
  const now = Date.now()
  if (u.disabled) {
    return { key: "disabled", label: "已禁用", chip: "bg-destructive/10 text-destructive", dot: "bg-destructive" }
  }
  if (u.status === "departed") {
    return { key: "departed", label: "离职", chip: "bg-muted text-muted-foreground", dot: "bg-muted-foreground/50" }
  }
  if (u.status === "suspended") {
    return { key: "suspended", label: "停用", chip: "bg-[#d4a017]/12 text-[#a8721f] dark:text-[#e3b84e]", dot: "bg-[#d4a017]" }
  }
  if (u.expires_at && new Date(u.expires_at).getTime() <= now) {
    return { key: "expired", label: "已过期", chip: "bg-[#d4a017]/12 text-[#a8721f] dark:text-[#e3b84e]", dot: "bg-[#d4a017]" }
  }
  if (u.locked_until && new Date(u.locked_until).getTime() > now) {
    return { key: "locked", label: "已锁定", chip: "bg-[#d4a017]/12 text-[#a8721f] dark:text-[#e3b84e]", dot: "bg-[#d4a017]" }
  }
  return { key: "active", label: "在职", chip: "bg-[#5db872]/14 text-[#3f8f54] dark:text-[#7cc78a]", dot: "bg-[#5db872]" }
}
