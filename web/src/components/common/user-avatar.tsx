"use client"

// 首字母彩色头像 —— 按用户名稳定 hash 选一档暖色配色（DESIGN.md 调色板 + 数据色，
// 不掺冷蓝），渲染 tint 背景 + 同色文字的圆形头像。有 avatar_url 时优先显示图片。
// 零配置、即刻统一好看，深浅模式都耐看。

import * as React from "react"
import { cn } from "@/lib/utils"

// 每项 = tint 背景 + 同色更深的文字（浅色）+ 提亮文字（深色）。全暖色。
const PALETTE = [
  "bg-[#cc785c]/15 text-[#b35f43] dark:text-[#e0997f]", // coral
  "bg-[#5db872]/16 text-[#3f8f54] dark:text-[#7cc78a]", // sage
  "bg-[#e8a55a]/20 text-[#a8721f] dark:text-[#e8b878]", // amber
  "bg-[#5db8a6]/16 text-[#3c8e7f] dark:text-[#79c7b8]", // teal
  "bg-[#c98a6b]/18 text-[#a8694a] dark:text-[#dba588]", // clay
  "bg-[#b08968]/18 text-[#876950] dark:text-[#cdab8c]", // taupe
] as const

const SIZES = {
  sm: "size-7 text-[11px]",
  md: "size-9 text-[13px]",
  lg: "size-12 text-base",
} as const

function hashString(s: string): number {
  let h = 0
  for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) >>> 0
  return h
}

function initials(name: string): string {
  const t = (name || "").trim()
  if (!t) return "?"
  const first = t[0]
  // 中文取首字；其余取首字母大写（邮箱/英文名都合适）。
  if (/[一-龥]/.test(first)) return first
  return first.toUpperCase()
}

export function UserAvatar({
  name,
  src,
  size = "md",
  className,
}: {
  name: string
  src?: string | null
  size?: keyof typeof SIZES
  className?: string
}) {
  const dim = SIZES[size].split(" ")[0]
  if (src) {
    // eslint-disable-next-line @next/next/no-img-element
    return (
      <img
        src={src}
        alt={name}
        className={cn("shrink-0 rounded-full object-cover ring-1 ring-border", dim, className)}
      />
    )
  }
  const palette = PALETTE[hashString(name || "?") % PALETTE.length]
  return (
    <span
      aria-hidden
      title={name}
      className={cn(
        "inline-flex shrink-0 select-none items-center justify-center rounded-full font-medium leading-none",
        SIZES[size],
        palette,
        className,
      )}
    >
      {initials(name)}
    </span>
  )
}
