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
  return <div className="h-screen w-screen overflow-hidden flex flex-col bg-background">{children}</div>
}
