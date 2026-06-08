"use client"

import * as React from "react"
import { useRouter } from "next/navigation"
import { isAuthenticated } from "@/lib/auth/tokens"
import { WatermarkProvider } from "@/components/watermark/watermark-context"

// Workspace owns the entire viewport — no Sidebar / TopBar chrome from the
// (app) group. Theme / react-query / sonner come from the root providers, so
// this layout only has to gate on auth. The anti-leak watermark lives here too
// (the (app) group has its own provider): this route group is the primary
// multi-session webssh/desktop surface and must be watermarked like the rest.
export default function WorkspaceLayout({ children }: { children: React.ReactNode }) {
  const router = useRouter()
  const [ready, setReady] = React.useState(false)

  React.useEffect(() => {
    if (!isAuthenticated()) {
      router.replace("/login")
      return
    }
    setReady(true)
  }, [router])

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
