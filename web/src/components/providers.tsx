"use client"

// i18next singleton initialization. Loaded as a side-effect so it runs
// once per app lifecycle before any client component calls
// `useTranslation()`. react-i18next reads from this global instance —
// no Provider needed in the tree.
import "@/i18n/config"

import * as React from "react"
import { QueryClient, QueryClientProvider } from "@tanstack/react-query"
import { ReactQueryDevtools } from "@tanstack/react-query-devtools"
import { ThemeProvider as NextThemesProvider } from "next-themes"
import { Toaster } from "@/components/ui/sonner"
import { TooltipProvider } from "@/components/ui/tooltip"
import { ConfirmDialogHost } from "@/components/common/confirm-dialog"
import { SplashScreen } from "@/components/splash/splash-screen"

export function Providers({ children }: { children: React.ReactNode }) {
  const [client] = React.useState(
    () =>
      new QueryClient({
        defaultOptions: {
          queries: {
            staleTime: 30 * 1000,
            refetchOnWindowFocus: false,
            retry: (failureCount, error: unknown) => {
              const e = error as { status?: number } | undefined
              if (e?.status === 401 || e?.status === 403 || e?.status === 404) return false
              return failureCount < 2
            },
          },
        },
      })
  )
  return (
    <NextThemesProvider attribute="class" defaultTheme="system" enableSystem disableTransitionOnChange>
      <QueryClientProvider client={client}>
        <TooltipProvider delayDuration={200}>
          {children}
          {/*
            位置 / 主题联动 / 图标徽章 / classNames / 语义色 CSS 变量与默认
            时长全部收敛在 @/components/ui/sonner 的 wrapper 与 globals.css 的
            「Sonner toast」区块。这里保持零内联 props,让全局 toast 视觉统一。
          */}
          <Toaster />
          <ConfirmDialogHost />
          {/* 全局启动动画 —— 挂在 next-themes 之内,故 bg-background 等 token 随主题解析;
              fixed inset-0 z-[9999] 覆盖所有路由组,每个浏览器会话仅展示一次。 */}
          <SplashScreen />
        </TooltipProvider>
        <ReactQueryDevtools initialIsOpen={false} />
      </QueryClientProvider>
    </NextThemesProvider>
  )
}
