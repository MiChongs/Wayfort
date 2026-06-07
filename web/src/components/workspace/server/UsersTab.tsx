"use client"

import * as React from "react"
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query"
import { Loader2, Lock, RefreshCw, Search as SearchIcon, Unlock, UserPlus, UsersRound } from "lucide-react"
import { toast } from "@/components/ui/sonner"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover"
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs"
import { useConfirm } from "@/components/admin/use-confirm"
import { usersService } from "@/lib/api/services"
import type { SysUser } from "@/lib/api/types"
import { cn } from "@/lib/utils"
import { VirtualTable } from "@/components/common/virtual-table"
import { codeOf, type ApiError } from "./_shared"

type Props = { nodeId: number; tabId: string; active: boolean }

function errorHint(code: string | undefined): string {
  if (code === "permission_denied") return "改账户需 root / sudo NOPASSWD。"
  if (code === "bad_request") return "用户名或组名不合法。"
  return ""
}

export function UsersTab({ nodeId, active }: Props) {
  const qc = useQueryClient()
  const { confirm, dialog } = useConfirm()
  const [search, setSearch] = React.useState("")
  const [showSystem, setShowSystem] = React.useState(false)
  const info = useQuery({
    queryKey: ["users", nodeId],
    queryFn: () => usersService.info(nodeId),
    enabled: active,
    refetchInterval: 30_000,
    retry: false,
  })
  const invalidate = () => void qc.invalidateQueries({ queryKey: ["users", nodeId] })

  const lock = useMutation({
    mutationFn: ({ user, lock }: { user: string; lock: boolean }) => usersService.lock(nodeId, user, lock),
    onSuccess: (_d, v) => { toast.success(`${v.user} 已${v.lock ? "锁定" : "解锁"}`); invalidate() },
    onError: (e: ApiError) => toast.error("操作失败", { description: errorHint(codeOf(e)) || e?.message }),
  })
  const addGroup = useMutation({
    mutationFn: ({ user, group }: { user: string; group: string }) => usersService.addToGroup(nodeId, user, group),
    onSuccess: (_d, v) => { toast.success(`${v.user} 已加入 ${v.group}`); invalidate() },
    onError: (e: ApiError) => toast.error("操作失败", { description: errorHint(codeOf(e)) || e?.message }),
  })

  const users = React.useMemo(() => {
    let list = info.data?.users ?? []
    if (!showSystem) list = list.filter((u) => !u.system)
    const q = search.trim().toLowerCase()
    if (q) list = list.filter((u) => u.name.toLowerCase().includes(q) || String(u.uid).includes(q))
    return list
  }, [info.data, showSystem, search])

  if (!active) return null
  if (info.isError) {
    return (
      <div className="p-6 text-center text-sm text-muted-foreground space-y-2">
        <UsersRound className="w-8 h-8 mx-auto opacity-50" />
        <div className="font-medium text-foreground">无法读取用户信息</div>
        <div className="text-xs">{(info.error as ApiError)?.message}</div>
        <Button size="sm" variant="outline" className="h-7 text-xs" onClick={() => info.refetch()}><RefreshCw className="w-3 h-3" /> 重试</Button>
      </div>
    )
  }
  const d = info.data

  return (
    <div className="flex flex-col h-full">
      {dialog}
      <header className="flex items-center justify-between gap-2 px-3 py-2 border-b bg-card">
        <div className="flex items-center gap-2 min-w-0">
          <UsersRound className="w-4 h-4 text-primary shrink-0" />
          <span className="text-xs font-medium">用户与登录</span>
        </div>
        <Button variant="ghost" size="icon" className="h-7 w-7" onClick={() => info.refetch()} title="刷新"><RefreshCw className={cn("w-3 h-3", info.isFetching && "animate-spin")} /></Button>
      </header>

      <Tabs defaultValue="users" className="flex-1 flex flex-col min-h-0">
        <TabsList className="mx-2 mt-2 h-8 bg-transparent border-b rounded-none p-0 self-start">
          <TabsTrigger value="users" className="text-xs">用户</TabsTrigger>
          <TabsTrigger value="online" className="text-xs">在线 {d ? `(${d.online.length})` : ""}</TabsTrigger>
          <TabsTrigger value="history" className="text-xs">历史</TabsTrigger>
          <TabsTrigger value="groups" className="text-xs">组</TabsTrigger>
        </TabsList>

        <TabsContent value="users" className="flex-1 min-h-0 mt-0 flex flex-col">
          <div className="px-2 py-1.5 border-b flex items-center gap-1.5">
            <div className="relative flex-1 min-w-0">
              <SearchIcon className="w-3.5 h-3.5 absolute left-2 top-1/2 -translate-y-1/2 text-muted-foreground" />
              <Input value={search} onChange={(e) => setSearch(e.target.value)} placeholder="过滤用户…" className="h-7 pl-7 text-xs" />
            </div>
            <Button size="sm" variant={showSystem ? "default" : "outline"} className="h-7 text-[11px]" onClick={() => setShowSystem((v) => !v)}>系统账户</Button>
          </div>
          <div className="min-h-0 flex-1">
            {!d ? (
              <div className="inline-flex items-center gap-2 p-6 text-xs text-muted-foreground"><Loader2 className="h-3 w-3 animate-spin" /> 加载…</div>
            ) : (
              <VirtualTable
                rows={users}
                empty="无匹配用户"
                header={
                  <>
                    <th className="px-3 py-1.5 text-left">用户</th>
                    <th className="px-2 py-1.5 text-right">UID</th>
                    <th className="px-2 py-1.5 text-left">Shell</th>
                    <th className="px-3 py-1.5 text-right">操作</th>
                  </>
                }
                renderRow={(u) => (
                  <UserRow
                    u={u}
                    busy={lock.isPending || addGroup.isPending}
                    onLock={async (l) => { if (!l || await confirm({ title: `锁定 ${u.name}？`, description: "锁定后该账户无法登录。", confirmLabel: "锁定" })) lock.mutate({ user: u.name, lock: l }) }}
                    onAddGroup={(group) => addGroup.mutate({ user: u.name, group })}
                  />
                )}
              />
            )}
          </div>
        </TabsContent>

        <TabsContent value="online" className="flex-1 min-h-0 mt-0 overflow-auto">
          {(d?.online.length ?? 0) === 0 ? (
            <div className="text-xs text-muted-foreground p-6 text-center">当前无登录会话</div>
          ) : (
            <table className="w-full text-[11px]">
              <tbody className="divide-y divide-border/40">
                {d!.online.map((o, i) => (
                  <tr key={i} className="hover:bg-muted/50">
                    <td className="px-3 py-1 font-medium">{o.user}</td>
                    <td className="px-2 py-1 font-mono text-muted-foreground">{o.tty}</td>
                    <td className="px-2 py-1 font-mono text-muted-foreground truncate">{o.from || "本地"}</td>
                    <td className="px-3 py-1 text-muted-foreground tabular-nums text-right whitespace-nowrap">{o.login}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </TabsContent>

        <TabsContent value="history" className="flex-1 min-h-0 mt-0 overflow-auto">
          {(d?.recent?.length ?? 0) === 0 ? (
            <div className="text-xs text-muted-foreground p-6 text-center">无登录历史</div>
          ) : (
            <table className="w-full text-[11px]">
              <tbody className="divide-y divide-border/40">
                {d!.recent!.map((h, i) => (
                  <tr key={i} className={cn("hover:bg-muted/50", h.failed && "text-destructive")}>
                    <td className="px-3 py-1 font-medium inline-flex items-center gap-1.5">
                      <span className={cn("inline-block w-1.5 h-1.5 rounded-full", h.failed ? "bg-destructive" : "bg-success")} />
                      {h.user}
                    </td>
                    <td className="px-2 py-1 font-mono text-muted-foreground truncate">{h.from || "—"}</td>
                    <td className="px-3 py-1 text-muted-foreground text-right whitespace-nowrap">{h.when}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </TabsContent>

        <TabsContent value="groups" className="flex-1 min-h-0 mt-0 overflow-auto">
          <table className="w-full text-[11px]">
            <tbody className="divide-y divide-border/40">
              {(d?.groups ?? []).filter((g) => (g.members?.length ?? 0) > 0).map((g) => (
                <tr key={g.name} className="hover:bg-muted/50">
                  <td className="px-3 py-1 font-mono align-top">{g.name}</td>
                  <td className="px-3 py-1 text-muted-foreground">{(g.members ?? []).join(", ")}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </TabsContent>
      </Tabs>
    </div>
  )
}

function UserRow({ u, busy, onLock, onAddGroup }: { u: SysUser; busy: boolean; onLock: (lock: boolean) => void; onAddGroup: (group: string) => void }) {
  const [grpOpen, setGrpOpen] = React.useState(false)
  const [grp, setGrp] = React.useState("")
  const nologin = (u.shell || "").includes("nologin") || (u.shell || "").endsWith("/false")
  return (
    <>
      <td className="px-3 py-1">
        <span className="font-medium">{u.name}</span>
        {u.system && <Badge variant="secondary" className="text-[9px] ml-1.5 px-1 h-4">系统</Badge>}
        {nologin && <Badge variant="outline" className="text-[9px] ml-1 px-1 h-4">nologin</Badge>}
      </td>
      <td className="px-2 py-1 text-right tabular-nums text-muted-foreground">{u.uid}</td>
      <td className="px-2 py-1 font-mono text-[10px] text-muted-foreground truncate max-w-[8rem]">{u.shell}</td>
      <td className="px-3 py-1 text-right">
        <div className="inline-flex gap-0.5">
          <Popover open={grpOpen} onOpenChange={setGrpOpen}>
            <PopoverTrigger asChild>
              <Button variant="ghost" size="icon" className="h-6 w-6" title="加入组" disabled={busy}><UserPlus className="w-3 h-3" /></Button>
            </PopoverTrigger>
            <PopoverContent align="end" className="w-56 p-2 space-y-2">
              <div className="text-xs font-medium">把 {u.name} 加入组</div>
              <Input value={grp} onChange={(e) => setGrp(e.target.value)} placeholder="组名，如 docker" className="h-8 text-xs" />
              <Button size="sm" className="h-7 w-full text-xs" disabled={!grp.trim()} onClick={() => { onAddGroup(grp.trim()); setGrp(""); setGrpOpen(false) }}>加入</Button>
            </PopoverContent>
          </Popover>
          <Button variant="ghost" size="icon" className="h-6 w-6" title="锁定" disabled={busy} onClick={() => onLock(true)}><Lock className="w-3 h-3" /></Button>
          <Button variant="ghost" size="icon" className="h-6 w-6" title="解锁" disabled={busy} onClick={() => onLock(false)}><Unlock className="w-3 h-3" /></Button>
        </div>
      </td>
    </>
  )
}
