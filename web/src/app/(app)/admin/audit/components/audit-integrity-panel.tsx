"use client"

import * as React from "react"
import { useQuery } from "@tanstack/react-query"
import { ChevronDown, ShieldAlert, ShieldCheck, ShieldQuestion } from "lucide-react"
import { auditService } from "@/lib/api/services"
import { cn } from "@/lib/utils"

// AuditIntegrityPanel surfaces the tamper-evidence report (security-architecture
// §5.2): per-chain hash-chain verification + signed checkpoints, plus the count
// of unprotected pre-M4 rows. Collapsed by default — it's a reassurance/forensic
// tool, not part of the day-to-day flow.
export function AuditIntegrityPanel() {
  const [open, setOpen] = React.useState(false)
  const q = useQuery({
    queryKey: ["admin", "audit", "integrity"],
    queryFn: auditService.integrity,
    enabled: open, // only fetch when the operator opens it (it walks the chain)
  })

  const chains = q.data?.chains ?? []
  const allIntact = chains.length > 0 && chains.every((c) => c.intact)
  const anyBroken = chains.some((c) => !c.intact)

  let Icon = ShieldQuestion
  let tone = "text-muted-foreground"
  if (q.data) {
    if (anyBroken) {
      Icon = ShieldAlert
      tone = "text-destructive"
    } else if (allIntact) {
      Icon = ShieldCheck
      tone = "text-emerald-600 dark:text-emerald-400"
    }
  }

  return (
    <div className="rounded-lg border">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className="flex w-full items-center gap-3 px-4 py-3 text-left"
      >
        <Icon className={cn("h-4 w-4 shrink-0", tone)} />
        <div className="min-w-0 flex-1">
          <div className="text-sm font-medium">审计完整性</div>
          <div className="truncate text-xs text-muted-foreground">
            {!q.data
              ? "防篡改哈希链 + 签名检查点 · 点击校验"
              : anyBroken
                ? "检测到链断裂——存在被篡改或删除的记录"
                : allIntact
                  ? `全部 ${chains.length} 条链完整`
                  : "尚无受保护的审计链"}
          </div>
        </div>
        <ChevronDown className={cn("h-4 w-4 shrink-0 text-muted-foreground transition-transform", open && "rotate-180")} />
      </button>

      {open && (
        <div className="border-t px-4 py-3">
          {q.isLoading && <div className="text-xs text-muted-foreground">校验中…</div>}
          {q.isError && <div className="text-xs text-destructive">校验失败</div>}
          {q.data && (
            <div className="space-y-3">
              {chains.length === 0 && (
                <div className="text-xs text-muted-foreground">还没有任何受保护的审计链。</div>
              )}
              {chains.map((c) => (
                <div key={c.chain_id} className="rounded-md bg-muted/30 p-3">
                  <div className="flex items-center justify-between gap-2">
                    <span className="font-mono text-xs text-muted-foreground">{c.chain_id.slice(0, 18)}…</span>
                    <span
                      className={cn(
                        "rounded px-1.5 py-0.5 text-xs font-medium",
                        c.intact
                          ? "bg-emerald-500/15 text-emerald-700 dark:text-emerald-400"
                          : "bg-destructive/15 text-destructive",
                      )}
                    >
                      {c.intact ? "完整" : `第 ${c.broken_at + 1} 行起断裂`}
                    </span>
                  </div>
                  <div className="mt-1 text-xs text-muted-foreground">
                    {c.entry_count.toLocaleString()} 条记录{c.truncated ? "（已截断校验）" : ""} ·{" "}
                    {c.checkpoints.length} 个检查点
                    {c.checkpoints.some((cp) => cp.signed) ? "（含签名）" : "（未签名）"}
                  </div>
                </div>
              ))}
              {q.data.unprotected_rows > 0 && (
                <div className="text-xs text-muted-foreground">
                  {q.data.unprotected_rows.toLocaleString()} 条历史记录在保护范围之外（M4 上线前）。
                </div>
              )}
            </div>
          )}
        </div>
      )}
    </div>
  )
}
