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
            position / closeButton / theme-sync / richColors / shadcn
            popover-token CSS variables all live inside the wrapper at
            @/components/ui/sonner. Keep this mount point free of inline
            props so the look stays consistent with shadcn defaults.
          */}
          <Toaster />
          <ConfirmDialogHost />
        </TooltipProvider>
        <ReactQueryDevtools initialIsOpen={false} />
      </QueryClientProvider>
    </NextThemesProvider>
  )
}
