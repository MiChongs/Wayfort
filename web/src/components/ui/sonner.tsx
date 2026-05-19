"use client"

// shadcn New York 官方 Toaster wrapper —— 几乎 1:1 复制自
// https://ui.shadcn.com/docs/components/sonner,只额外:
//   1) `richColors` —— success/error/warning/info 自动着色,跟 Alert.tsx
//      的视觉语义一致(红/绿/黄/蓝)
//   2) `closeButton` —— 用 sonner 内置样式,不自定义
//   3) `position="top-right"` —— 继承项目历史挂载位置
//   4) `--width: 400px` —— 防止长 description(例如 guacd 网络错误原文)
//      被截断成 "...the target machi"
//
// 不做的事:不再叠加 backdrop-blur / ring / 自定义 icon / 自定义
// classNames / 自定义动画 keyframes —— 那些会跟 sonner 自身的样式
// 系统打架,让 toast 视觉脱离 shadcn 设计语言。
//
// next-themes 的 resolvedTheme 透传给 sonner 的 theme prop,实现
// light/dark 联动。Provider 结构不变,所以现有 toast call site 零修改。

import * as React from "react"
import { useTheme } from "next-themes"
import { Toaster as SonnerToaster, toast, type ToasterProps } from "sonner"

export function Toaster(props: ToasterProps) {
  const { resolvedTheme } = useTheme()
  const theme = (resolvedTheme ?? "system") as ToasterProps["theme"]

  return (
    <SonnerToaster
      theme={theme}
      className="toaster group"
      position="top-right"
      richColors
      closeButton
      style={
        {
          "--normal-bg": "var(--popover)",
          "--normal-text": "var(--popover-foreground)",
          "--normal-border": "var(--border)",
          "--width": "400px",
        } as React.CSSProperties
      }
      {...props}
    />
  )
}

// Re-export sonner 的 toast,既支持现有 `import { toast } from "sonner"`,
// 也允许新 callsite 走 `import { toast } from "@/components/ui/sonner"`
// 收敛入口。
export { toast }
