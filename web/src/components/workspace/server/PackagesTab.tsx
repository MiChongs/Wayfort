"use client"

import * as React from "react"
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query"
import {
  ArrowUpCircle,
  Download,
  Loader2,
  Package,
  RefreshCw,
  Search as SearchIcon,
  Trash2,
} from "lucide-react"
import { toast } from "@/components/ui/sonner"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import {
  Sheet,
  SheetContent,
  SheetHeader,
  SheetTitle,
} from "@/components/ui/sheet"
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs"
import { useConfirm } from "@/components/admin/use-confirm"
import { packageService } from "@/lib/api/services"
import type { PkgActionResult, PkgVerb } from "@/lib/api/types"
import { cn } from "@/lib/utils"
import { codeOf, type ApiError } from "./_shared"

type Props = { nodeId: number; tabId: string; active: boolean }

function errorHint(code: string | undefined, msg: string): string {
  if (code === "permission_denied") return "安装/卸载需 root，或为包管理器配置 sudoers NOPASSWD。"
  if (code === "no_manager") return "未检测到受支持的包管理器。"
  return ""
}

export function PackagesTab({ nodeId, active }: Props) {
  const qc = useQueryClient()
  const { confirm, dialog } = useConfirm()
  const [result, setResult] = React.useState<{ title: string; output: string } | null>(null)

  const status = useQuery({
    queryKey: ["packages", nodeId, "status"],
    queryFn: () => packageService.status(nodeId),
    enabled: active,
    refetchInterval: 60_000,
    retry: false,
  })
  const upgradable = useQuery({
    queryKey: ["packages", nodeId, "upgradable"],
    queryFn: () => packageService.upgradable(nodeId),
    enabled: active && !!status.data?.available,
    retry: false,
  })

  const action = useMutation({
    mutationFn: ({ verb, name }: { verb: PkgVerb; name?: string }) => packageService.action(nodeId, verb, name),
    onSuccess: (r: PkgActionResult, v) => {
      setResult({ title: `${v.verb}${v.name ? " " + v.name : ""}`, output: r.output })
      toast.success("操作完成")
      void qc.invalidateQueries({ queryKey: ["packages", nodeId] })
    },
    onError: (e: ApiError) => toast.error("操作失败", { description: errorHint(codeOf(e), e?.message || "") || e?.message }),
  })

  if (!active) return null

  if (status.isError || (status.data && !status.data.available)) {
    return (
      <div className="p-6 text-center text-sm text-muted-foreground space-y-2">
        <Package className="w-8 h-8 mx-auto opacity-50" />
        <div className="font-medium text-foreground">软件包不可用</div>
        <div className="text-xs">{status.data?.reason || (status.error as ApiError)?.message}</div>
        <Button size="sm" variant="outline" className="h-7 text-xs" onClick={() => status.refetch()}><RefreshCw className="w-3 h-3" /> 重试</Button>
      </div>
    )
  }
  const s = status.data
  const busy = action.isPending

  return (
    <div className="flex flex-col h-full">
      {dialog}
      <header className="flex items-center justify-between gap-2 px-3 py-2 border-b bg-card">
        <div className="flex items-center gap-2 min-w-0">
          <Package className="w-4 h-4 text-primary shrink-0" />
          <span className="text-xs font-medium">软件包</span>
          {s && (
            <span className="text-[10px] text-muted-foreground truncate">
              {s.manager} · {s.installed_count} 已装
              {s.upgradable_count > 0 && <span className="text-warning"> · {s.upgradable_count} 可更新</span>}
              {s.security_count > 0 && <span className="text-destructive"> · {s.security_count} 安全</span>}
            </span>
          )}
        </div>
        <Button variant="ghost" size="icon" className="h-7 w-7" onClick={() => { status.refetch(); upgradable.refetch() }} title="刷新"><RefreshCw className={cn("w-3 h-3", (status.isFetching || upgradable.isFetching) && "animate-spin")} /></Button>
      </header>

      <Tabs defaultValue="updates" className="flex-1 flex flex-col min-h-0">
        <TabsList className="mx-2 mt-2 h-8 bg-transparent border-b rounded-none p-0 self-start">
          <TabsTrigger value="updates" className="text-xs">可更新</TabsTrigger>
          <TabsTrigger value="search" className="text-xs">搜索</TabsTrigger>
        </TabsList>

        <TabsContent value="updates" className="flex-1 min-h-0 mt-0 flex flex-col">
          <div className="px-2 py-1.5 border-b flex items-center gap-1.5">
            <Button size="sm" variant="outline" className="h-7 text-xs" disabled={busy} onClick={() => action.mutate({ verb: "update" })}><RefreshCw className="w-3 h-3" /> 更新缓存</Button>
            <Button size="sm" variant="outline" className="h-7 text-xs" disabled={busy || (s?.upgradable_count ?? 0) === 0} onClick={async () => { if (await confirm({ title: "升级全部软件包？", description: "将升级所有可更新的包，可能耗时较久。", confirmLabel: "升级" })) action.mutate({ verb: "upgrade-all" }) }}>
              <ArrowUpCircle className="w-3 h-3" /> 全部升级
            </Button>
            {busy && <Loader2 className="w-3.5 h-3.5 animate-spin text-muted-foreground" />}
          </div>
          <div className="flex-1 overflow-auto">
            {upgradable.isLoading ? (
              <div className="text-xs text-muted-foreground p-6 inline-flex items-center gap-2"><Loader2 className="w-3 h-3 animate-spin" /> 加载…</div>
            ) : (upgradable.data?.updates?.length ?? 0) === 0 ? (
              <div className="text-xs text-muted-foreground p-6 text-center">已是最新</div>
            ) : (
              <table className="w-full text-[11px]">
                <tbody className="divide-y divide-border/40">
                  {upgradable.data!.updates.map((u) => (
                    <tr key={u.name} className="hover:bg-muted/50">
                      <td className="px-3 py-1 font-mono">
                        {u.name}
                        {u.security && <Badge variant="destructive" className="text-[9px] ml-1.5 px-1 h-4">安全</Badge>}
                      </td>
                      <td className="px-2 py-1 font-mono text-[10px] text-muted-foreground truncate max-w-[10rem]">
                        {u.current ? `${u.current} → ` : ""}<span className="text-success">{u.candidate}</span>
                      </td>
                      <td className="px-3 py-1 text-right">
                        <Button variant="ghost" size="icon" className="h-6 w-6" title="升级" disabled={busy} onClick={() => action.mutate({ verb: "upgrade", name: u.name })}><ArrowUpCircle className="w-3 h-3" /></Button>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </div>
        </TabsContent>

        <TabsContent value="search" className="flex-1 min-h-0 mt-0 flex flex-col">
          <SearchPanel nodeId={nodeId} busy={busy} onInstall={(name) => action.mutate({ verb: "install", name })} onRemove={async (name) => { if (await confirm({ title: `卸载 ${name}？`, description: "将移除该软件包。", confirmLabel: "卸载" })) action.mutate({ verb: "remove", name }) }} />
        </TabsContent>
      </Tabs>

      <Sheet open={!!result} onOpenChange={(v) => !v && setResult(null)}>
        <SheetContent side="right" className="w-[min(640px,calc(100vw-2rem))] sm:max-w-none flex flex-col gap-3">
          <SheetHeader><SheetTitle className="font-mono">{result?.title}</SheetTitle></SheetHeader>
          <pre className="flex-1 overflow-auto bg-muted/60 rounded-md p-2 text-[11px] font-mono whitespace-pre-wrap break-words leading-5">{result?.output || "（无输出）"}</pre>
        </SheetContent>
      </Sheet>
    </div>
  )
}

function SearchPanel({ nodeId, busy, onInstall, onRemove }: { nodeId: number; busy: boolean; onInstall: (name: string) => void; onRemove: (name: string) => void }) {
  const [q, setQ] = React.useState("")
  const [submitted, setSubmitted] = React.useState("")
  const search = useQuery({
    queryKey: ["packages", nodeId, "search", submitted],
    queryFn: () => packageService.search(nodeId, submitted),
    enabled: submitted !== "",
    retry: false,
  })
  return (
    <>
      <div className="p-2 border-b flex items-center gap-1.5">
        <div className="relative flex-1 min-w-0">
          <SearchIcon className="w-3.5 h-3.5 absolute left-2 top-1/2 -translate-y-1/2 text-muted-foreground" />
          <Input value={q} onChange={(e) => setQ(e.target.value)} onKeyDown={(e) => { if (e.key === "Enter" && q.trim()) setSubmitted(q.trim()) }} placeholder="搜索软件包…" className="h-7 pl-7 text-xs" />
        </div>
        <Button size="sm" className="h-7 text-xs" disabled={!q.trim()} onClick={() => setSubmitted(q.trim())}>搜索</Button>
      </div>
      <div className="flex-1 overflow-auto">
        {submitted === "" ? (
          <div className="text-xs text-muted-foreground p-6 text-center">输入关键字搜索可安装的软件包。</div>
        ) : search.isLoading ? (
          <div className="text-xs text-muted-foreground p-6 inline-flex items-center gap-2"><Loader2 className="w-3 h-3 animate-spin" /> 搜索…</div>
        ) : (search.data?.packages?.length ?? 0) === 0 ? (
          <div className="text-xs text-muted-foreground p-6 text-center">无结果</div>
        ) : (
          <table className="w-full text-[11px]">
            <tbody className="divide-y divide-border/40">
              {search.data!.packages.map((p) => (
                <tr key={p.name} className="hover:bg-muted/50">
                  <td className="px-3 py-1 align-top">
                    <div className="font-mono font-medium">{p.name}</div>
                    {p.summary && <div className="text-[10px] text-muted-foreground truncate max-w-[16rem]" title={p.summary}>{p.summary}</div>}
                  </td>
                  <td className="px-3 py-1 text-right align-top w-16">
                    <div className="inline-flex gap-0.5">
                      <Button variant="ghost" size="icon" className="h-6 w-6" title="安装" disabled={busy} onClick={() => onInstall(p.name)}><Download className="w-3 h-3" /></Button>
                      <Button variant="ghost" size="icon" className="h-6 w-6 text-destructive" title="卸载" disabled={busy} onClick={() => onRemove(p.name)}><Trash2 className="w-3 h-3" /></Button>
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
    </>
  )
}
