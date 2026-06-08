"use client"

import * as React from "react"
import { Globe, List, Power, Shield, ShieldBan, ShieldCheck } from "lucide-react"
import { Button } from "@/components/ui/button"
import { StatCard } from "@/components/insights/stat-card"
import { VirtualTable } from "@/components/common/virtual-table"
import type { ExposurePort, FirewallRuleSpec, FirewallSnapshot } from "@/lib/api/types"
import { cn } from "@/lib/utils"
import { FwIconEmpty, useElementWidth, VerdictPill, verdictTone } from "./shared"

export function OverviewView({
  snapshot,
  onAddRule,
}: {
  snapshot: FirewallSnapshot
  onAddRule: (prefill: Partial<FirewallRuleSpec>) => void
}) {
  const ports = snapshot.exposure ?? []
  const openCount = ports.filter((p) => p.verdict === "open").length
  const restricted = ports.filter((p) => p.verdict === "restricted").length
  const denyDefault = /deny|drop|reject/i.test(`${snapshot.policy ?? ""} ${snapshot.default_in ?? ""}`)

  return (
    <div className="h-full min-h-0 space-y-3 overflow-auto p-3">
      <div className="grid grid-cols-2 gap-2 lg:grid-cols-3 xl:grid-cols-6">
        <StatCard icon={Shield} label="工具" value={(snapshot.tool || "—").toUpperCase()} />
        <StatCard icon={Power} label="状态" value={snapshot.active ? "运行" : "停止"} tone={snapshot.active ? "success" : "warning"} />
        <StatCard icon={ShieldCheck} label="默认入站" value={denyDefault ? "拒绝" : "允许"} tone={denyDefault ? "success" : "warning"} hint={snapshot.policy} />
        <StatCard icon={List} label="规则" value={snapshot.rule_count} hint={snapshot.chains?.length ? `${snapshot.chains.length} 链` : undefined} />
        <StatCard icon={Globe} label="对外暴露" value={openCount} tone={openCount > 0 ? "warning" : "success"} hint={`${restricted} 受限`} />
        <StatCard icon={ShieldBan} label="封禁 IP" value={snapshot.fail2ban?.banned_total ?? "—"} hint={snapshot.fail2ban ? `${snapshot.fail2ban.jail_count} jail` : "未装 fail2ban"} />
      </div>

      <div className="flex items-center gap-2">
        <span className="text-[10px] uppercase tracking-wide text-muted-foreground">对外暴露端口</span>
        <div className="flex items-center gap-2 text-[10px] text-muted-foreground">
          <Legend tone="open" /> <Legend tone="restricted" /> <Legend tone="blocked" />
        </div>
      </div>
      <ExposureMatrix ports={ports} onAddRule={onAddRule} />
    </div>
  )
}

function Legend({ tone }: { tone: "open" | "restricted" | "blocked" }) {
  const t = verdictTone(tone)
  return (
    <span className="inline-flex items-center gap-1">
      <span className={cn("h-1.5 w-1.5 rounded-full", t.text.replace("text-", "bg-"))} /> {t.label}
    </span>
  )
}

function ExposureMatrix({
  ports,
  onAddRule,
}: {
  ports: ExposurePort[]
  onAddRule: (prefill: Partial<FirewallRuleSpec>) => void
}) {
  const [ref, width] = useElementWidth<HTMLDivElement>()
  const sorted = React.useMemo(() => {
    const rank = { open: 0, restricted: 1, blocked: 2, local: 3 } as Record<string, number>
    return [...ports].sort((a, b) => (rank[a.verdict] - rank[b.verdict]) || a.port - b.port)
  }, [ports])

  if (ports.length === 0) {
    return <FwIconEmpty title="无监听端口" sub="未检出对外监听的服务（或无读取权限）。" />
  }

  // narrow panel → card stack
  if (width > 0 && width < 480) {
    return (
      <div ref={ref} className="space-y-1.5">
        {sorted.map((p) => (
          <div key={`${p.proto}:${p.port}`} className={cn("rounded-md border px-2.5 py-2", verdictTone(p.verdict).wash)}>
            <div className="flex items-center justify-between gap-2">
              <span className="flex items-center gap-1.5">
                <VerdictPill v={p.verdict} />
                <span className="shrink-0 font-mono text-xs tabular-nums">:{p.port}/{p.proto}</span>
              </span>
              {p.verdict === "open" && (
                <Button size="sm" variant="outline" className="h-6 px-2 text-[10px]" onClick={() => onAddRule({ port: String(p.port), protocol: p.proto })}>收紧</Button>
              )}
            </div>
            <div className="mt-0.5 truncate text-[10px] text-muted-foreground">{p.process || "—"} · {p.listen_addr}</div>
          </div>
        ))}
      </div>
    )
  }

  return (
    <div ref={ref}>
      <div className="h-[min(420px,52vh)] overflow-hidden rounded-md border">
        <VirtualTable<ExposurePort>
          rows={sorted}
          empty="无监听端口"
          header={
            <>
              <th className="px-2 py-1.5 text-left">裁决</th>
              <th className="px-2 py-1.5 text-left">端口</th>
              <th className="px-2 py-1.5 text-left">监听</th>
              <th className="px-2 py-1.5 text-left">进程</th>
              <th className="px-2 py-1.5 text-left">放行来源</th>
              <th className="px-2 py-1.5 text-right">操作</th>
            </>
          }
          renderRow={(p) => (
            <>
              <td className="px-2 py-1"><VerdictPill v={p.verdict} /></td>
              <td className="whitespace-nowrap px-2 py-1 font-mono text-[10px] tabular-nums">:{p.port}/{p.proto}</td>
              <td className="max-w-[8rem] truncate px-2 py-1 font-mono text-[10px] text-muted-foreground" title={p.listen_addr}>{p.listen_addr}</td>
              <td className="max-w-[7rem] truncate px-2 py-1 text-[10px]" title={`${p.process ?? ""} ${p.pid ? `(${p.pid})` : ""}`}>{p.process || "—"}</td>
              <td className="max-w-[8rem] truncate px-2 py-1 font-mono text-[10px] text-muted-foreground" title={(p.allowed_from ?? []).join(", ")}>
                {p.verdict === "open" ? "任意" : (p.allowed_from ?? []).join(", ") || "—"}
              </td>
              <td className="whitespace-nowrap px-1 py-0.5 text-right">
                <Button size="sm" variant="ghost" className="h-6 px-2 text-[10px]" onClick={() => onAddRule({ port: String(p.port), protocol: p.proto, action: p.verdict === "open" ? "DENY" : "ALLOW" })}>
                  {p.verdict === "open" ? "收紧" : "放行"}
                </Button>
              </td>
            </>
          )}
        />
      </div>
    </div>
  )
}
