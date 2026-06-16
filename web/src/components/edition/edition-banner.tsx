"use client"

import Link from "next/link"
import { AlertTriangle } from "lucide-react"
import { useEdition } from "@/lib/hooks/use-edition"
import { useAccess } from "@/lib/hooks/use-access"
import { cn } from "@/lib/utils"

// EditionBanner is a non-intrusive strip shown only when the license needs
// attention (grace / expired / invalid). It never blocks the app — the gateway
// keeps running (degraded for paid features), matching the "fail-open, warn
// loudly" stance. Super-admins get a deep link to the license page.
export function EditionBanner() {
  const { state, info, needsAttention } = useEdition()
  const { isSuperadmin } = useAccess()

  if (!needsAttention) return null

  const tone =
    state === "grace"
      ? "border-warning/30 bg-warning/10 text-warning"
      : "border-destructive/30 bg-destructive/10 text-destructive"

  const fallback =
    state === "grace"
      ? "授权已进入宽限期，请尽快续期，否则企业/旗舰功能将停用。"
      : state === "expired"
        ? "授权已过期，企业/旗舰功能已停用。"
        : "授权无效，企业/旗舰功能已停用。"

  return (
    <div className={cn("flex items-center gap-2 border-b px-4 py-2 text-sm", tone)}>
      <AlertTriangle className="size-4 shrink-0" />
      <span className="min-w-0 flex-1 truncate">{info?.message || fallback}</span>
      {isSuperadmin && (
        <Link href="/admin/edition" className="shrink-0 font-medium underline underline-offset-2">
          前往授权管理
        </Link>
      )}
    </div>
  )
}
