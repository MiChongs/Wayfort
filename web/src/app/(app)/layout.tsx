"use client"

import * as React from "react"
import { Sidebar } from "@/components/app-shell/sidebar"
import { TopBar } from "@/components/app-shell/topbar"
import { CommandPalette } from "@/components/common/command-palette"
import { NotificationProvider } from "@/components/notifications/notification-provider"
import { WatermarkProvider } from "@/components/watermark/watermark-context"
import { useAuthSession } from "@/lib/auth/use-auth-session"

export default function AppLayout({ children }: { children: React.ReactNode }) {
  const ready = useAuthSession()
  const [mobileOpen, setMobileOpen] = React.useState(false)

  if (!ready) return null
  return (
    <NotificationProvider>
      <WatermarkProvider>
        {/* Fill the viewport-locked body; main is the single scroll container. */}
        <div className="flex h-full overflow-hidden">
          <Sidebar />
          <div className="flex-1 min-w-0 flex flex-col overflow-hidden">
            <TopBar onMobileMenu={() => setMobileOpen(true)} mobileOpen={mobileOpen} onMobileClose={() => setMobileOpen(false)} />
            <main className="flex-1 min-h-0 overflow-y-auto">{children}</main>
          </div>
          <CommandPalette />
        </div>
      </WatermarkProvider>
    </NotificationProvider>
  )
}
