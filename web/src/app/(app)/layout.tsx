"use client"

import * as React from "react"
import { useRouter } from "next/navigation"
import { isAuthenticated } from "@/lib/auth/tokens"
import { Sidebar } from "@/components/app-shell/sidebar"
import { TopBar } from "@/components/app-shell/topbar"

export default function AppLayout({ children }: { children: React.ReactNode }) {
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
  return (
    <div className="flex min-h-screen">
      <Sidebar />
      <div className="flex-1 min-w-0 flex flex-col">
        <TopBar />
        <main className="flex-1 min-h-0 overflow-y-auto">{children}</main>
      </div>
    </div>
  )
}
