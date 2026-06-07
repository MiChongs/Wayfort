"use client"

// Sonner 挂载点 —— 卡片视觉已完全自定义(见 @/components/ui/toast.tsx,用
// toast.custom() 渲染自绘组件),所以这里的 <Toaster> 只配置全局行为:主题联动、
// 挂载位置、堆叠间距 / 偏移 / 可见数量、容器宽度。不再需要 richColors /
// closeButton / icons / toastOptions —— 那些都是「结构化 toast」的开关,自绘
// 卡片一律不用。
//
// toast() API 从 ./toast 收敛导出,新旧 callsite 统一 `import { toast } from
// "@/components/ui/sonner"`。

import * as React from "react"
import { useTheme } from "next-themes"
import { Toaster as SonnerToaster, type ToasterProps } from "sonner"

export function Toaster(props: ToasterProps) {
  const { resolvedTheme } = useTheme()
  const theme = (resolvedTheme ?? "system") as ToasterProps["theme"]

  return (
    <SonnerToaster
      theme={theme}
      className="toaster"
      position="top-right"
      gap={12}
      offset={18}
      visibleToasts={4}
      style={
        {
          // custom toast 是 unstyled 的,sonner 不给 <li> 设宽度;容器宽度与
          // ToastCard 的 w-[360px] 对齐,保证右上角定位与堆叠落点一致。
          "--width": "360px",
        } as React.CSSProperties
      }
      {...props}
    />
  )
}

// 收敛入口:全项目 `import { toast } from "@/components/ui/sonner"`。
export { toast } from "@/components/ui/toast"
export type { ToastOptions, ToastTone, ToastAction } from "@/components/ui/toast"
