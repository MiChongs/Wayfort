"use client"

import * as React from "react"
import {
  Activity,
  FileCog,
  Gauge,
  List,
  Loader2,
  ScrollText,
  ShieldBan,
  Stethoscope,
} from "lucide-react"
import { useSseSnapshot } from "@/lib/hooks/use-sse-snapshot"
import { Button } from "@/components/ui/button"
import type { FirewallApplyRequest, FirewallRuleSpec, FirewallSnapshot } from "@/lib/api/types"
import { cn } from "@/lib/utils"
import { firewallStreamURL } from "./_live"
import { FwInstallPanel } from "./firewall/install"
import { OverviewView } from "./firewall/overview"
import { RulesView } from "./firewall/rules"
import { ConntrackView } from "./firewall/conntrack"
import { FwLogsView } from "./firewall/logs"
import { Fail2banView } from "./firewall/fail2ban"
import { DiagnoseView } from "./firewall/diagnose"
import { ImportExportDialog } from "./firewall/import-export"
import { useSafeApply } from "./firewall/safe-apply"
import { FwIconEmpty, useElementWidth, type FwView } from "./firewall/shared"

type Props = { nodeId: number; tabId: string; active: boolean }

const VIEWS: { key: FwView; label: string; icon: React.ComponentType<{ className?: string }> }[] = [
  { key: "overview", label: "概览", icon: Gauge },
  { key: "rules", label: "规则", icon: List },
  { key: "connections", label: "连接", icon: Activity },
  { key: "logs", label: "日志", icon: ScrollText },
  { key: "fail2ban", label: "fail2ban", icon: ShieldBan },
  { key: "diagnose", label: "诊断", icon: Stethoscope },
]

export function FirewallTab({ nodeId, tabId, active }: Props) {
  const url = React.useMemo(() => firewallStreamURL(nodeId), [nodeId])
  const { data, status, error } = useSseSnapshot<FirewallSnapshot>(url, { enabled: active })
  const [view, setView] = React.useState<FwView>("overview")
  const [toolsOpen, setToolsOpen] = React.useState(false)
  const [prefill, setPrefill] = React.useState<Partial<FirewallRuleSpec> | undefined>(undefined)
  const [prefillNonce, setPrefillNonce] = React.useState(0)
  const { run: safeRun, modal: safeModal } = useSafeApply(nodeId)

  const onSafeApply = React.useCallback((req: FirewallApplyRequest) => safeRun(req), [safeRun])
  const onAddRule = React.useCallback((p: Partial<FirewallRuleSpec>) => {
    setPrefill(p)
    setPrefillNonce((n) => n + 1)
    setView("rules")
  }, [])

  if (!active) return null
  if (status === "error" && !data) return <FwIconEmpty title="无法读取防火墙" sub={error} />
  if (!data) {
    return <div className="inline-flex items-center gap-2 p-6 text-xs text-muted-foreground"><Loader2 className="h-3 w-3 animate-spin" /> 采集中…</div>
  }
  if (!data.installed || data.tool === "") {
    return <FwInstallPanel nodeId={nodeId} tabId={tabId} active={active} reason={data.reason} />
  }

  return (
    <div className="flex h-full min-h-0 flex-col">
      {safeModal}
      <FwViewNav value={view} onChange={setView} onTools={() => setToolsOpen(true)} />
      <div className="min-h-0 flex-1">
        {view === "overview" && <OverviewView snapshot={data} onAddRule={onAddRule} />}
        {view === "rules" && <RulesView nodeId={nodeId} tabId={tabId} snapshot={data} onSafeApply={onSafeApply} prefill={prefill} prefillNonce={prefillNonce} />}
        {view === "connections" && <ConntrackView nodeId={nodeId} active={active && view === "connections"} />}
        {view === "logs" && <FwLogsView nodeId={nodeId} active={active && view === "logs"} />}
        {view === "fail2ban" && <Fail2banView nodeId={nodeId} tabId={tabId} active={active && view === "fail2ban"} />}
        {view === "diagnose" && <DiagnoseView nodeId={nodeId} active={active && view === "diagnose"} />}
      </div>
      <ImportExportDialog open={toolsOpen} onClose={() => setToolsOpen(false)} nodeId={nodeId} tool={data.tool} onSafeApply={onSafeApply} />
    </div>
  )
}

function FwViewNav({ value, onChange, onTools }: { value: FwView; onChange: (v: FwView) => void; onTools: () => void }) {
  const [ref, width] = useElementWidth<HTMLDivElement>()
  const compact = width > 0 && width < 420
  return (
    <div ref={ref} className="flex items-center gap-1 border-b bg-card px-2 py-1.5">
      {VIEWS.map((v) => {
        const Icon = v.icon
        const on = value === v.key
        return (
          <button
            key={v.key}
            type="button"
            onClick={() => onChange(v.key)}
            title={v.label}
            className={cn(
              "inline-flex items-center gap-1 rounded-md px-2 py-1 text-[11px] transition-colors",
              on ? "bg-accent font-medium text-foreground" : "text-muted-foreground hover:bg-accent/50",
            )}
          >
            <Icon className="h-3.5 w-3.5 shrink-0" />
            {!compact && <span>{v.label}</span>}
          </button>
        )
      })}
      <Button variant="ghost" size="icon" className="ml-auto h-6 w-6 shrink-0" title="模板 / 导入导出" onClick={onTools}>
        <FileCog className="h-3.5 w-3.5" />
      </Button>
    </div>
  )
}
