"use client"

import * as React from "react"
import { WatermarkProvider } from "@/components/watermark/watermark-context"
import { useAuthSession } from "@/lib/auth/use-auth-session"

// Workspace owns the entire viewport — no Sidebar / TopBar chrome from the
// (app) group. Theme / react-query / sonner come from the root providers, so
// this layout only has to gate on auth. The anti-leak watermark lives here too
// (the (app) group has its own provider): this route group is the primary
// multi-session webssh/desktop surface and must be watermarked like the rest.
export default function WorkspaceLayout({ children }: { children: React.ReactNode }) {
  const ready = useAuthSession()

  if (!ready) return null
  // Fill the viewport-locked body (h-full, not h-screen/100vh — follows the real
  // body height with no vh quirks); status bar sits flush at the foot. w-full,
  // not w-screen, avoids the 100vw-includes-scrollbar footgun.
  return (
    <WatermarkProvider>
      <div className="h-full w-full overflow-hidden flex flex-col bg-background">{children}</div>
    </WatermarkProvider>
  )
}
