"use client"

import * as React from "react"
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query"
import { Loader2, Pencil, RefreshCw, Search as SearchIcon, SlidersHorizontal } from "lucide-react"
import { toast } from "@/components/ui/sonner"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Checkbox } from "@/components/ui/checkbox"
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover"
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs"
import { kernelService } from "@/lib/api/services"
import type { KSysctl } from "@/lib/api/types"
import { cn } from "@/lib/utils"
import { codeOf, type ApiError } from "./_shared"

type Props = { nodeId: number; tabId: string; active: boolean }

const SYSCTL_CAP = 400

function errorHint(code: string | undefined, msg: string): string {
  if (code === "permission_denied" || /permission|root/i.test(msg)) return "写 sysctl 需 root，或为 sysctl 配置 sudoers NOPASSWD。"
  if (code === "unreachable") return "节点 SSH 不可达。"
  return ""
}

export function KernelTab({ nodeId, active }: Props) {
  const qc = useQueryClient()
  const [search, setSearch] = React.useState("")
  const info = useQuery({
    queryKey: ["kernel", nodeId],
    queryFn: () => kernelService.info(nodeId),
    enabled: active,
    refetchInterval: 30_000,
    retry: false,
  })

  const setSysctl = useMutation({
    mutationFn: ({ key, value, persist }: { key: string; value: string; persist: boolean }) =>
      kernelService.setSysctl(nodeId, key, value, persist),
    onSuccess: (_d, v) => {
      toast.success(`已设置 ${v.key} = ${v.value}`)
      void qc.invalidateQueries({ queryKey: ["kernel", nodeId] })
    },
    onError: (e: ApiError) => toast.error("设置失败", { description: errorHint(codeOf(e), e?.message || "") || e?.message }),
  })

  const sysctls = React.useMemo(() => {
    const all = info.data?.sysctls ?? []
    const q = search.trim().toLowerCase()
    const filtered = q ? all.filter((s) => s.key.toLowerCase().includes(q) || s.value.toLowerCase().includes(q)) : all
    return { total: filtered.length, rows: filtered.slice(0, SYSCTL_CAP) }
  }, [info.data, search])

  if (!active) return null

  if (info.isError) {
    return (
      <div className="p-6 text-center text-sm text-muted-foreground space-y-2">
        <SlidersHorizontal className="w-8 h-8 mx-auto opacity-50" />
        <div className="font-medium text-foreground">无法读取内核参数</div>
        <div className="text-xs">{(info.error as ApiError)?.message}</div>
        <Button size="sm" variant="outline" className="h-7 text-xs" onClick={() => info.refetch()}><RefreshCw className="w-3 h-3" /> 重试</Button>
      </div>
    )
  }

  const d = info.data

  return (
    <div className="flex flex-col h-full">
      <header className="flex items-center justify-between gap-2 px-3 py-2 border-b bg-card">
        <div className="flex items-center gap-2 min-w-0">
          <SlidersHorizontal className="w-4 h-4 text-primary shrink-0" />
          <span className="text-xs font-medium">内核与参数</span>
          {d && <span className="text-[10px] text-muted-foreground truncate">{d.kernel} · {d.hostname}{d.timezone ? ` · ${d.timezone}` : ""}</span>}
        </div>
        <Button variant="ghost" size="icon" className="h-7 w-7" onClick={() => info.refetch()} title="刷新">
          <RefreshCw className={cn("w-3 h-3", info.isFetching && "animate-spin")} />
        </Button>
      </header>

      <Tabs defaultValue="sysctl" className="flex-1 flex flex-col min-h-0">
        <TabsList className="mx-2 mt-2 h-8 bg-transparent border-b rounded-none p-0 self-start">
          <TabsTrigger value="sysctl" className="text-xs">sysctl</TabsTrigger>
          <TabsTrigger value="modules" className="text-xs">模块</TabsTrigger>
          <TabsTrigger value="limits" className="text-xs">限制</TabsTrigger>
        </TabsList>

        <TabsContent value="sysctl" className="flex-1 min-h-0 mt-0 flex flex-col">
          <div className="p-2 border-b flex items-center gap-2">
            <div className="relative flex-1 min-w-0">
              <SearchIcon className="w-3.5 h-3.5 absolute left-2 top-1/2 -translate-y-1/2 text-muted-foreground" />
              <Input value={search} onChange={(e) => setSearch(e.target.value)} placeholder="过滤参数，如 vm.swappiness…" className="h-7 pl-7 text-xs font-mono" />
            </div>
            <Badge variant="outline" className="text-[10px] shrink-0">{sysctls.total}</Badge>
          </div>
          <div className="flex-1 overflow-auto">
            {!d ? (
              <div className="text-xs text-muted-foreground p-6 inline-flex items-center gap-2"><Loader2 className="w-3 h-3 animate-spin" /> 加载…</div>
            ) : (
              <table className="w-full text-[11px]">
                <tbody className="divide-y divide-border/40">
                  {sysctls.rows.map((s) => (
                    <SysctlRow key={s.key} s={s} busy={setSysctl.isPending} onApply={(value, persist) => setSysctl.mutate({ key: s.key, value, persist })} />
                  ))}
                </tbody>
              </table>
            )}
            {sysctls.total > SYSCTL_CAP && (
              <div className="text-[10px] text-muted-foreground p-2 text-center">仅显示前 {SYSCTL_CAP} 项，继续输入以缩小范围。</div>
            )}
          </div>
        </TabsContent>

        <TabsContent value="modules" className="flex-1 min-h-0 mt-0 overflow-auto">
          <table className="w-full text-[11px]">
            <thead className="bg-muted/40 sticky top-0 text-[10px] uppercase text-muted-foreground">
              <tr><th className="text-left px-3 py-1.5">模块</th><th className="text-right px-2 py-1.5">大小</th><th className="text-left px-3 py-1.5">被使用</th></tr>
            </thead>
            <tbody className="divide-y divide-border/40">
              {(d?.modules ?? []).map((m) => (
                <tr key={m.name} className="hover:bg-muted/50">
                  <td className="px-3 py-1 font-mono">{m.name}</td>
                  <td className="px-2 py-1 text-right tabular-nums text-muted-foreground">{m.size_kb}KB</td>
                  <td className="px-3 py-1 font-mono text-muted-foreground truncate max-w-[10rem]" title={m.used_by}>{m.used_by || "—"}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </TabsContent>

        <TabsContent value="limits" className="flex-1 min-h-0 mt-0 overflow-auto p-3">
          <pre className="font-mono text-[11px] whitespace-pre-wrap leading-5">{d?.limits || "ulimit 不可用"}</pre>
        </TabsContent>
      </Tabs>
    </div>
  )
}

function SysctlRow({ s, busy, onApply }: { s: KSysctl; busy: boolean; onApply: (value: string, persist: boolean) => void }) {
  const [open, setOpen] = React.useState(false)
  const [val, setVal] = React.useState(s.value)
  const [persist, setPersist] = React.useState(false)
  React.useEffect(() => { if (open) { setVal(s.value); setPersist(false) } }, [open, s.value])
  return (
    <tr className="hover:bg-muted/50 group">
      <td className="px-3 py-1 font-mono align-top">{s.key}</td>
      <td className="px-2 py-1 font-mono text-right tabular-nums text-muted-foreground align-top max-w-[8rem] truncate" title={s.value}>{s.value || "—"}</td>
      <td className="px-2 py-1 text-right align-top w-8">
        <Popover open={open} onOpenChange={setOpen}>
          <PopoverTrigger asChild>
            <Button variant="ghost" size="icon" className="h-6 w-6 opacity-0 group-hover:opacity-100" title="修改">
              <Pencil className="w-3 h-3" />
            </Button>
          </PopoverTrigger>
          <PopoverContent align="end" className="w-64 p-3 space-y-2">
            <div className="text-xs font-medium font-mono break-all">{s.key}</div>
            <Input value={val} onChange={(e) => setVal(e.target.value)} className="h-8 text-xs font-mono" />
            <label className="flex items-center gap-2 text-[11px] text-muted-foreground">
              <Checkbox checked={persist} onCheckedChange={(v) => setPersist(!!v)} />
              持久化到 /etc/sysctl.d（重启后仍生效）
            </label>
            <Button size="sm" className="h-7 w-full text-xs" disabled={busy || !val.trim() || val === s.value} onClick={() => { onApply(val.trim(), persist); setOpen(false) }}>应用</Button>
          </PopoverContent>
        </Popover>
      </td>
    </tr>
  )
}
