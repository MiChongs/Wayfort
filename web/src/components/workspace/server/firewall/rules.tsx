"use client"

import * as React from "react"
import { useMutation, useQueryClient } from "@tanstack/react-query"
import { ChevronDown, ChevronUp, Pencil, Plus, Trash2 } from "lucide-react"
import { toast } from "@/components/ui/sonner"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Checkbox } from "@/components/ui/checkbox"
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select"
import { Sparkline } from "@/components/insights/sparkline"
import { VirtualTable } from "@/components/common/virtual-table"
import { useConfirm } from "@/components/admin/use-confirm"
import type { FirewallRule, FirewallRuleSpec, FirewallSnapshot } from "@/lib/api/types"
import type { HistoryPoint } from "@/lib/hooks/use-insights-history"
import { cn } from "@/lib/utils"
import { firewallService } from "@/lib/api/services"
import { codeOf, RunInTerminalButton, type ApiError } from "../_shared"
import { RuleFormDialog } from "./rule-form"
import { actionTone, caps, errorHint, fmtBytes, fmtPkts, ruleKey, SectionHeader } from "./shared"

function onErr(e: ApiError) {
  toast.error("操作失败", { description: errorHint(codeOf(e), e?.message || "") || e?.message })
}

// useRuleCounters keeps a per-rule sliding window of packet counts for
// sparklines. Each update produces a NEW array (never mutates the stored one) —
// the array we hand to <Sparkline> may be frozen by recharts, so pushing into
// the same reference on the next frame would throw "object is not extensible".
function useRuleCounters(rules: FirewallRule[]) {
  const ref = React.useRef<Map<string, HistoryPoint[]>>(new Map())
  const last = React.useRef<FirewallRule[] | null>(null)
  if (rules !== last.current) {
    last.current = rules
    const m = ref.current
    const seen = new Set<string>()
    let t = 0
    for (const r of rules) {
      const k = ruleKey(r)
      seen.add(k)
      const prev = m.get(k) ?? []
      const next = prev.length >= 40 ? prev.slice(prev.length - 39) : prev.slice()
      next.push({ t: t++, v: r.pkts ?? 0 })
      m.set(k, next)
    }
    for (const k of Array.from(m.keys())) if (!seen.has(k)) m.delete(k)
  }
  return ref.current
}

export function RulesView({
  nodeId,
  tabId,
  snapshot,
  onSafeApply,
  prefill,
  prefillNonce,
}: {
  nodeId: number
  tabId: string
  snapshot: FirewallSnapshot
  onSafeApply: (req: import("@/lib/api/types").FirewallApplyRequest) => void
  prefill?: Partial<FirewallRuleSpec>
  prefillNonce?: number
}) {
  const qc = useQueryClient()
  const { confirm, dialog } = useConfirm()
  const cap = caps(snapshot.tool)
  const sshPort = snapshot.ssh_port ?? 22
  const rules = snapshot.rules ?? []
  const counters = useRuleCounters(rules)

  const [q, setQ] = React.useState("")
  const [family, setFamily] = React.useState("all")
  const [act, setAct] = React.useState("all")
  const [selected, setSelected] = React.useState<Set<string>>(new Set())
  const [formOpen, setFormOpen] = React.useState(false)
  const [formInitial, setFormInitial] = React.useState<Partial<FirewallRuleSpec> | undefined>(undefined)
  const [editRule, setEditRule] = React.useState<FirewallRule | null>(null)

  // open the add form pre-filled when the overview "收紧/放行" action fires.
  React.useEffect(() => {
    if (prefillNonce) {
      setFormInitial(prefill)
      setFormOpen(true)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [prefillNonce])

  const filtered = React.useMemo(() => {
    const needle = q.trim().toLowerCase()
    return rules.filter((r) => {
      if (family !== "all" && (r.family ?? "") !== family) return false
      if (act !== "all" && r.action.toUpperCase() !== act) return false
      if (!needle) return true
      return `${r.port ?? ""} ${r.source ?? ""} ${r.raw ?? ""}`.toLowerCase().includes(needle)
    })
  }, [rules, q, family, act])

  const touchesSSH = (r: FirewallRule) => r.action.toUpperCase() === "ALLOW" && portCovers(r.port, sshPort)

  const del = useMutation({
    mutationFn: (index: number) => firewallService.deleteRule(nodeId, index),
    onSuccess: () => toast.success("已删除"),
    onError: onErr,
  })
  const move = useMutation({
    mutationFn: (v: { from: number; to: number }) => firewallService.moveRule(nodeId, v),
    onError: onErr,
  })
  const add = useMutation({
    mutationFn: (spec: FirewallRuleSpec) => firewallService.addRule(nodeId, spec),
    onSuccess: () => { toast.success("已添加"); setFormOpen(false) },
    onError: onErr,
  })
  const edit = useMutation({
    mutationFn: (v: { index: number; spec: FirewallRuleSpec; handle?: number; chain?: string }) =>
      firewallService.editRule(nodeId, v.index, { new_spec: v.spec, handle: v.handle, chain: v.chain }),
    onSuccess: () => { toast.success("已保存"); setEditRule(null) },
    onError: onErr,
  })

  const onDelete = async (r: FirewallRule) => {
    if (touchesSSH(r)) {
      onSafeApply({ kind: "delete", indexes: [r.index], confirm: true })
      return
    }
    const ok = await confirm({ title: "删除该规则？", description: r.raw, confirmLabel: "删除" })
    if (ok) del.mutate(r.index)
  }

  const onAdd = (spec: FirewallRuleSpec) => {
    if (spec.action !== "ALLOW" && portCovers(spec.port, sshPort)) {
      onSafeApply({ kind: "add", spec, confirm: true })
      setFormOpen(false)
      return
    }
    add.mutate(spec)
  }
  const onEdit = (spec: FirewallRuleSpec) => {
    if (!editRule) return
    if (spec.action !== "ALLOW" && portCovers(spec.port, sshPort)) {
      onSafeApply({ kind: "edit", edit: { index: editRule.index, handle: editRule.handle, chain: editRule.chain, new_spec: spec }, confirm: true })
      setEditRule(null)
      return
    }
    edit.mutate({ index: editRule.index, spec, handle: editRule.handle, chain: editRule.chain })
  }

  const onBulkDelete = async () => {
    const idxs = filtered.filter((r) => selected.has(ruleKey(r))).map((r) => r.index)
    if (idxs.length === 0) return
    const risky = filtered.some((r) => selected.has(ruleKey(r)) && touchesSSH(r))
    if (risky) {
      onSafeApply({ kind: "bulk", indexes: idxs, confirm: true })
      setSelected(new Set())
      return
    }
    const ok = await confirm({ title: `删除选中的 ${idxs.length} 条规则？`, confirmLabel: "删除" })
    if (ok) {
      await firewallService.bulkDelete(nodeId, idxs).catch(onErr)
      setSelected(new Set())
      void qc.invalidateQueries({ queryKey: ["fw", nodeId] })
    }
  }

  const toggleSel = (k: string) =>
    setSelected((s) => { const n = new Set(s); n.has(k) ? n.delete(k) : n.add(k); return n })

  return (
    <div className="flex h-full min-h-0 flex-col">
      {dialog}
      <SectionHeader title="规则" count={`${filtered.length}/${rules.length}`}>
        {selected.size > 0 ? (
          <>
            <span className="text-[10px] text-muted-foreground">已选 {selected.size}</span>
            <Button size="sm" variant="outline" className="h-7 gap-1 text-xs text-destructive" onClick={onBulkDelete}><Trash2 className="h-3.5 w-3.5" /> 删除</Button>
            <Button size="sm" variant="ghost" className="h-7 text-xs" onClick={() => setSelected(new Set())}>取消</Button>
          </>
        ) : (
          <Button size="sm" className="h-7 gap-1 text-xs" onClick={() => setFormOpen(true)}><Plus className="h-3.5 w-3.5" /> 添加</Button>
        )}
      </SectionHeader>

      <div className="flex items-center gap-1.5 border-b bg-card/60 px-3 py-1.5">
        <Input value={q} onChange={(e) => setQ(e.target.value)} placeholder="搜索 端口/来源/原文" className="h-7 flex-1 text-xs" />
        <Select value={act} onValueChange={setAct}>
          <SelectTrigger className="h-7 w-20 text-xs"><SelectValue /></SelectTrigger>
          <SelectContent>
            <SelectItem value="all">全部</SelectItem>
            <SelectItem value="ALLOW">允许</SelectItem>
            <SelectItem value="DENY">拒绝</SelectItem>
            <SelectItem value="REJECT">回绝</SelectItem>
          </SelectContent>
        </Select>
        <Select value={family} onValueChange={setFamily}>
          <SelectTrigger className="h-7 w-20 text-xs"><SelectValue /></SelectTrigger>
          <SelectContent>
            <SelectItem value="all">全族</SelectItem>
            <SelectItem value="inet">IPv4</SelectItem>
            <SelectItem value="inet6">IPv6</SelectItem>
          </SelectContent>
        </Select>
      </div>

      <div className="min-h-0 flex-1">
        <VirtualTable<FirewallRule>
          rows={filtered}
          empty="无规则"
          header={
            <>
              <th className="px-1 py-1.5" />
              <th className="px-2 py-1.5 text-left">#</th>
              <th className="px-2 py-1.5 text-left">命中</th>
              <th className="px-2 py-1.5 text-left">动作</th>
              <th className="px-2 py-1.5 text-left">端口</th>
              <th className="px-2 py-1.5 text-left">来源</th>
              <th className="px-2 py-1.5 text-left">链</th>
              <th className="px-2 py-1.5 text-right">操作</th>
            </>
          }
          renderRow={(r) => {
            const k = ruleKey(r)
            const hist = counters.get(k) ?? []
            return (
              <>
                <td className="px-1 py-1"><Checkbox checked={selected.has(k)} onCheckedChange={() => toggleSel(k)} /></td>
                <td className="px-2 py-1 text-[10px] tabular-nums text-muted-foreground">{r.index}</td>
                <td className="px-2 py-1">
                  <div className="flex items-center gap-1">
                    <Sparkline data={hist} height={18} color="var(--chart-1)" className="w-10" />
                    <span className="font-mono text-[9px] text-muted-foreground" title={`${r.pkts ?? 0} 包 / ${r.bytes ?? 0} 字节`}>{fmtPkts(r.pkts ?? 0)}·{fmtBytes(r.bytes ?? 0)}</span>
                  </div>
                </td>
                <td className="px-2 py-1"><Badge className={cn("h-4 px-1.5 text-[9px]", actionTone(r.action))}>{r.action}</Badge></td>
                <td className="whitespace-nowrap px-2 py-1 font-mono text-[10px]">{r.port || "any"}{r.protocol ? `/${r.protocol}` : ""}</td>
                <td className="max-w-[7rem] truncate px-2 py-1 font-mono text-[10px] text-muted-foreground" title={r.source}>{r.source || "—"}</td>
                <td className="px-2 py-1 text-[9px] text-muted-foreground">{r.chain || "—"}{r.family ? ` ${r.family === "inet6" ? "v6" : "v4"}` : ""}</td>
                <td className="whitespace-nowrap px-1 py-0.5 text-right">
                  <div className="inline-flex items-center gap-0.5">
                    {cap.reorder && (
                      <>
                        <Button variant="ghost" size="icon" className="h-6 w-6" title="上移" onClick={() => move.mutate({ from: r.index, to: Math.max(1, r.index - 1) })}><ChevronUp className="h-3 w-3" /></Button>
                        <Button variant="ghost" size="icon" className="h-6 w-6" title="下移" onClick={() => move.mutate({ from: r.index, to: r.index + 1 })}><ChevronDown className="h-3 w-3" /></Button>
                      </>
                    )}
                    {cap.edit && (
                      <Button variant="ghost" size="icon" className="h-6 w-6" title="编辑" onClick={() => setEditRule(r)}><Pencil className="h-3 w-3" /></Button>
                    )}
                    <RunInTerminalButton tabId={tabId} command={r.raw} run={false} label="改到终端" />
                    <Button variant="ghost" size="icon" className="h-6 w-6 text-destructive" title="删除" onClick={() => onDelete(r)}><Trash2 className="h-3 w-3" /></Button>
                  </div>
                </td>
              </>
            )
          }}
        />
      </div>

      <RuleFormDialog open={formOpen} onClose={() => setFormOpen(false)} nodeId={nodeId} mode="add" initial={formInitial} busy={add.isPending} onSubmit={onAdd} />
      {editRule && (
        <RuleFormDialog
          open
          onClose={() => setEditRule(null)}
          nodeId={nodeId}
          mode="edit"
          busy={edit.isPending}
          initial={{ action: editRule.action.toUpperCase() as FirewallRuleSpec["action"], direction: editRule.direction as "in" | "out", protocol: (editRule.protocol as FirewallRuleSpec["protocol"]) ?? "tcp", port: editRule.port, source: editRule.source, comment: editRule.comment }}
          onSubmit={onEdit}
        />
      )}
    </div>
  )
}

function portCovers(spec: string | undefined, port: number): boolean {
  if (!spec) return true
  for (const part of spec.split(",")) {
    const p = part.trim()
    const m = p.match(/^(\d+)[:-](\d+)$/)
    if (m) {
      if (port >= Number(m[1]) && port <= Number(m[2])) return true
    } else if (Number(p) === port) return true
  }
  return false
}
