"use client"

import Link from "next/link"
import { ArrowLeft } from "lucide-react"
import { SessionSwimlanes } from "@/components/viz/session-swimlanes"

// Global session timeline — every session as a bar on a per-user/per-asset lane
// so concurrency, busy assets, and live sessions read at a glance.
export default function SessionsTimelinePage() {
  return (
    <div className="mx-auto w-full max-w-7xl space-y-5 p-6">
      <div>
        <Link
          href="/sessions"
          className="inline-flex items-center gap-1 text-xs text-muted-foreground hover:text-foreground"
        >
          <ArrowLeft className="h-3.5 w-3.5" /> 会话列表
        </Link>
        <h1 className="mt-2 text-2xl font-semibold">会话时间线</h1>
        <p className="mt-1 text-sm text-muted-foreground">
          按用户或资产分泳道展示时间窗内的全部会话，直观看到并发与活跃热点。
        </p>
      </div>
      <SessionSwimlanes />
    </div>
  )
}
