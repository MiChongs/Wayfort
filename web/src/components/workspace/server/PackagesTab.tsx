"use client"

import * as React from "react"
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query"
import {
  ArrowUpCircle,
  Download,
  Loader2,
  Lock,
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
  SheetDescription,
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
  if (code === "unsupported") return "当前包管理器不支持该操作。"
  return ""
}

export function PackagesTab({ nodeId, active }: Props) {
  const qc = useQueryClient()
  const { confirm, dialog } = useConfirm()
  const [result, setResult] = React.useState<{ title: string; output: string } | null>(null)
  const [detail, setDetail] = React.useState<string | null>(null)

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

  const invalidate = () => void qc.invalidateQueries({ queryKey: ["packages", nodeId] })
  const action = useMutation({
    mutationFn: ({ verb, name }: { verb: PkgVerb; name?: string }) => packageService.action(nodeId, verb, name),
    onSuccess: (r: PkgActionResult, v) => { setResult({ title: `${v.verb}${v.name ? " " + v.name : ""}`, output: r.output }); toast.success("操作完成"); invalidate() },
    onError: (e: ApiError) => toast.error("操作失败", { description: errorHint(codeOf(e), e?.message || "") || e?.message }),
  })
  const hold = useMutation({
    mutationFn: ({ name, hold }: { name: string; hold: boolean }) => packageService.hold(nodeId, name, hold),
    onSuccess: (_d, v) => { toast.success(v.hold ? `已锁定 ${v.name}` : `已解锁 ${v.name}`); invalidate() },
    onError: (e: ApiError) => toast.error("锁定失败", { description: errorHint(codeOf(e), e?.message || "") || e?.message }),
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
          <TabsTrigger value="installed" className="text-xs">已装</TabsTrigger>
          <TabsTrigger value="search" className="text-xs">搜索</TabsTrigger>
          <TabsTrigger value="history" className="text-xs">历史</TabsTrigger>
        </TabsList>

        <TabsContent value="updates" className="flex-1 min-h-0 mt-0 flex flex-col">
          <div className="px-2 py-1.5 border-b flex items-center gap-1.5 flex-wrap">
            <Button size="sm" variant="outline" className="h-7 text-xs" disabled={busy} onClick={() => action.mutate({ verb: "update" })}><RefreshCw className="w-3 h-3" /> 更新缓存</Button>
            <Button size="sm" variant="outline" className="h-7 text-xs" disabled={busy || (s?.upgradable_count ?? 0) === 0} onClick={async () => { if (await confirm({ title: "升级全部软件包？", description: "将升级所有可更新的包，可能耗时较久。", confirmLabel: "升级" })) action.mutate({ verb: "upgrade-all" }) }}><ArrowUpCircle className="w-3 h-3" /> 全部升级</Button>
            <Button size="sm" variant="ghost" className="h-7 text-xs" disabled={busy} onClick={async () => { if (await confirm({ title: "autoremove？", description: "移除不再被依赖的孤立包。", confirmLabel: "执行" })) action.mutate({ verb: "autoremove" }) }}>autoremove</Button>
            <Button size="sm" variant="ghost" className="h-7 text-xs" disabled={busy} onClick={() => action.mutate({ verb: "clean" })}>clean</Button>
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
                      <td className="px-3 py-1">
                        <button type="button" className="font-mono hover:text-primary" onClick={() => setDetail(u.name)}>{u.name}</button>
                        {u.security && <Badge variant="destructive" className="text-[9px] ml-1.5 px-1 h-4">安全</Badge>}
                      </td>
                      <td className="px-2 py-1 font-mono text-[10px] text-muted-foreground truncate max-w-[9rem]">{u.current ? `${u.current} → ` : ""}<span className="text-success">{u.candidate}</span></td>
                      <td className="px-3 py-1 text-right">
                        <div className="inline-flex gap-0.5">
                          <Button variant="ghost" size="icon" className="h-6 w-6" title="锁定版本(hold)" disabled={hold.isPending} onClick={() => hold.mutate({ name: u.name, hold: true })}><Lock className="w-3 h-3" /></Button>
                          <Button variant="ghost" size="icon" className="h-6 w-6" title="升级" disabled={busy} onClick={() => action.mutate({ verb: "upgrade", name: u.name })}><ArrowUpCircle className="w-3 h-3" /></Button>
                        </div>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </div>
        </TabsContent>

        <TabsContent value="installed" className="flex-1 min-h-0 mt-0 flex flex-col">
          <InstalledPanel nodeId={nodeId} active={active} onDetail={setDetail} onRemove={async (name) => { if (await confirm({ title: `卸载 ${name}？`, confirmLabel: "卸载" })) action.mutate({ verb: "remove", name }) }} busy={busy} />
        </TabsContent>

        <TabsContent value="search" className="flex-1 min-h-0 mt-0 flex flex-col">
          <SearchPanel nodeId={nodeId} busy={busy} onDetail={setDetail} onInstall={(name) => action.mutate({ verb: "install", name })} onRemove={async (name) => { if (await confirm({ title: `卸载 ${name}？`, confirmLabel: "卸载" })) action.mutate({ verb: "remove", name }) }} />
        </TabsContent>

        <TabsContent value="history" className="flex-1 min-h-0 mt-0 overflow-auto">
          <HistoryPanel nodeId={nodeId} active={active} />
        </TabsContent>
      </Tabs>

      <PkgDetailSheet nodeId={nodeId} name={detail} onClose={() => setDetail(null)} onHold={(n, h) => hold.mutate({ name: n, hold: h })} />

      <Sheet open={!!result} onOpenChange={(v) => !v && setResult(null)}>
        <SheetContent side="right" className="w-[min(640px,calc(100vw-2rem))] sm:max-w-none flex flex-col gap-3">
          <SheetHeader><SheetTitle className="font-mono">{result?.title}</SheetTitle></SheetHeader>
          <pre className="flex-1 overflow-auto bg-muted/60 rounded-md p-2 text-[11px] font-mono whitespace-pre-wrap break-words leading-5">{result?.output || "（无输出）"}</pre>
        </SheetContent>
      </Sheet>
    </div>
  )
}

function InstalledPanel({ nodeId, active, onDetail, onRemove, busy }: { nodeId: number; active: boolean; onDetail: (n: string) => void; onRemove: (n: string) => void; busy: boolean }) {
  const [q, setQ] = React.useState("")
  const installed = useQuery({ queryKey: ["packages", nodeId, "installed"], queryFn: () => packageService.installed(nodeId), enabled: active, retry: false })
  const rows = React.useMemo(() => {
    const all = installed.data?.packages ?? []
    const t = q.trim().toLowerCase()
    return (t ? all.filter((p) => p.name.toLowerCase().includes(t)) : all).slice(0, 500)
  }, [installed.data, q])
  return (
    <>
      <div className="p-2 border-b flex items-center gap-2">
        <div className="relative flex-1 min-w-0">
          <SearchIcon className="w-3.5 h-3.5 absolute left-2 top-1/2 -translate-y-1/2 text-muted-foreground" />
          <Input value={q} onChange={(e) => setQ(e.target.value)} placeholder="过滤已装包…" className="h-7 pl-7 text-xs" />
        </div>
        <Badge variant="outline" className="text-[10px]">{installed.data?.packages?.length ?? 0}</Badge>
      </div>
      <div className="flex-1 overflow-auto">
        {installed.isLoading ? (
          <div className="text-xs text-muted-foreground p-6 inline-flex items-center gap-2"><Loader2 className="w-3 h-3 animate-spin" /> 加载…</div>
        ) : (
          <table className="w-full text-[11px]">
            <tbody className="divide-y divide-border/40">
              {rows.map((p) => (
                <tr key={p.name} className="hover:bg-muted/50">
                  <td className="px-3 py-1"><button type="button" className="font-mono hover:text-primary" onClick={() => onDetail(p.name)}>{p.name}</button></td>
                  <td className="px-2 py-1 font-mono text-[10px] text-muted-foreground truncate max-w-[9rem]">{p.version}</td>
                  <td className="px-3 py-1 text-right"><Button variant="ghost" size="icon" className="h-6 w-6 text-destructive" title="卸载" disabled={busy} onClick={() => onRemove(p.name)}><Trash2 className="w-3 h-3" /></Button></td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
    </>
  )
}

function SearchPanel({ nodeId, busy, onInstall, onRemove, onDetail }: { nodeId: number; busy: boolean; onInstall: (n: string) => void; onRemove: (n: string) => void; onDetail: (n: string) => void }) {
  const [q, setQ] = React.useState("")
  const [submitted, setSubmitted] = React.useState("")
  const search = useQuery({ queryKey: ["packages", nodeId, "search", submitted], queryFn: () => packageService.search(nodeId, submitted), enabled: submitted !== "", retry: false })
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
                    <button type="button" className="font-mono font-medium hover:text-primary" onClick={() => onDetail(p.name)}>{p.name}</button>
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

function HistoryPanel({ nodeId, active }: { nodeId: number; active: boolean }) {
  const q = useQuery({ queryKey: ["packages", nodeId, "history"], queryFn: () => packageService.history(nodeId), enabled: active, retry: false })
  if (q.isLoading) return <div className="text-xs text-muted-foreground p-6 inline-flex items-center gap-2"><Loader2 className="w-3 h-3 animate-spin" /> 加载…</div>
  return <pre className="p-3 font-mono text-[10px] whitespace-pre-wrap leading-5">{(q.data?.lines ?? []).join("\n") || "无历史记录"}</pre>
}

function PkgDetailSheet({ nodeId, name, onClose, onHold }: { nodeId: number; name: string | null; onClose: () => void; onHold: (name: string, hold: boolean) => void }) {
  const info = useQuery({ queryKey: ["packages", nodeId, "info", name], queryFn: () => packageService.info(nodeId, name as string), enabled: !!name, retry: false })
  const files = useQuery({ queryKey: ["packages", nodeId, "files", name], queryFn: () => packageService.files(nodeId, name as string), enabled: !!name, retry: false })
  const d = info.data
  return (
    <Sheet open={!!name} onOpenChange={(v) => !v && onClose()}>
      <SheetContent side="right" className="w-[min(600px,calc(100vw-2rem))] sm:max-w-none flex flex-col gap-3">
        <SheetHeader>
          <SheetTitle className="font-mono">{name}</SheetTitle>
          <SheetDescription>{d?.summary || "软件包详情"}</SheetDescription>
        </SheetHeader>
        {name && (
          <div className="flex items-center gap-1.5">
            <Button size="sm" variant="outline" className="h-7 text-xs" onClick={() => onHold(name, true)}><Lock className="w-3.5 h-3.5" /> 锁定</Button>
            <Button size="sm" variant="ghost" className="h-7 text-xs" onClick={() => onHold(name, false)}>解锁</Button>
          </div>
        )}
        <Tabs defaultValue="info" className="flex-1 flex flex-col min-h-0">
          <TabsList className="h-8 self-start"><TabsTrigger value="info" className="text-xs">详情</TabsTrigger><TabsTrigger value="files" className="text-xs">文件</TabsTrigger><TabsTrigger value="raw" className="text-xs">Raw</TabsTrigger></TabsList>
          <TabsContent value="info" className="flex-1 min-h-0 mt-2 overflow-auto">
            {info.isLoading ? <div className="text-xs text-muted-foreground inline-flex items-center gap-2"><Loader2 className="w-3 h-3 animate-spin" /> 加载…</div> : d ? (
              <dl className="text-[11px] grid grid-cols-[5rem_1fr] gap-x-3 gap-y-1.5">
                <KV k="版本" v={d.version || "—"} />
                <KV k="已安装" v={d.installed ? "是" : "否"} />
                {d.size ? <KV k="大小" v={d.size} /> : null}
                {d.section ? <KV k="来源/段" v={d.section} /> : null}
                {d.homepage ? <KV k="主页" v={d.homepage} /> : null}
                {(d.depends?.length ?? 0) > 0 ? <KV k="依赖" v={d.depends!.join("\n")} /> : null}
              </dl>
            ) : <div className="text-xs text-destructive">{(info.error as ApiError)?.message}</div>}
          </TabsContent>
          <TabsContent value="files" className="flex-1 min-h-0 mt-2 overflow-auto">
            {files.isLoading ? <div className="text-xs text-muted-foreground">加载…</div> : (
              <pre className="font-mono text-[10px] whitespace-pre-wrap leading-5">{(files.data?.files ?? []).join("\n") || "无文件清单"}</pre>
            )}
          </TabsContent>
          <TabsContent value="raw" className="flex-1 min-h-0 mt-2 overflow-auto">
            <pre className="font-mono text-[10px] whitespace-pre-wrap leading-5">{d?.raw || ""}</pre>
          </TabsContent>
        </Tabs>
      </SheetContent>
    </Sheet>
  )
}

function KV({ k, v }: { k: string; v: string }) {
  return (<><dt className="text-muted-foreground">{k}</dt><dd className="whitespace-pre-wrap break-words">{v}</dd></>)
}
