"use client"

import * as React from "react"
import { useRouter } from "next/navigation"
import { isAuthenticated } from "@/lib/auth/tokens"

// Workspace owns the entire viewport — no Sidebar / TopBar chrome from the
// (app) group. Theme / react-query / sonner come from the root providers, so
// this layout only has to gate on auth.
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
  // h-screen + overflow-hidden locks the shell to the viewport (status bar sits
  // flush at the foot). w-full (not w-screen) avoids the 100vw-includes-scrollbar
  // footgun that can cause a stray horizontal overflow.
  return <div className="h-screen w-full overflow-hidden flex flex-col bg-background">{children}</div>
}
