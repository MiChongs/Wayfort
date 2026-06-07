"use client"

import * as React from "react"
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query"
import { HardDrive, Loader2, Plug, RefreshCw, Unplug } from "lucide-react"
import { toast } from "@/components/ui/sonner"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui/collapsible"
import { Progress } from "@/components/ui/progress"
import { useConfirm } from "@/components/admin/use-confirm"
import { usagePctBg, usagePctTone, formatBytes } from "@/components/insights/format"
import { storageService } from "@/lib/api/services"
import type { StBlockDevice, StorageInfo } from "@/lib/api/types"
import { cn } from "@/lib/utils"
import { codeOf, type ApiError } from "./_shared"

type Props = { nodeId: number; tabId: string; active: boolean }

function errorHint(code: string | undefined, msg: string): string {
  if (code === "permission_denied" || /permission|root/i.test(msg)) return "挂载/卸载需 root，或配置 sudoers NOPASSWD。"
  if (code === "busy") return "目标忙：有进程正在使用该挂载点。"
  if (code === "unreachable") return "节点 SSH 不可达。"
  return ""
}

export function StorageTab({ nodeId, active }: Props) {
  const qc = useQueryClient()
  const { confirm, dialog } = useConfirm()
  const info = useQuery({
    queryKey: ["storage", nodeId],
    queryFn: () => storageService.info(nodeId),
    enabled: active,
    refetchInterval: 15_000,
    retry: false,
  })

  const mount = useMutation({
    mutationFn: ({ target, unmount }: { target: string; unmount: boolean }) =>
      unmount ? storageService.unmount(nodeId, target) : storageService.mount(nodeId, target),
    onSuccess: (_d, v) => {
      toast.success(v.unmount ? `已卸载 ${v.target}` : `已挂载 ${v.target}`)
      void qc.invalidateQueries({ queryKey: ["storage", nodeId] })
    },
    onError: (e: ApiError) => toast.error("操作失败", { description: errorHint(codeOf(e), e?.message || "") || e?.message }),
  })

  const mountedSet = React.useMemo(() => {
    const set = new Set<string>()
    for (const f of info.data?.filesystems ?? []) set.add(f.mount)
    return set
  }, [info.data])

  const onMountOp = async (target: string, unmount: boolean) => {
    if (unmount) {
      const ok = await confirm({ title: `卸载 ${target}？`, description: "占用该挂载点的进程会受影响。", confirmLabel: "卸载" })
      if (!ok) return
    }
    mount.mutate({ target, unmount })
  }

  if (!active) return null

  if (info.isError) {
    return (
      <div className="p-6 text-center text-sm text-muted-foreground space-y-2">
        <HardDrive className="w-8 h-8 mx-auto opacity-50" />
        <div className="font-medium text-foreground">无法读取存储信息</div>
        <div className="text-xs">{(info.error as ApiError)?.message}</div>
        <Button size="sm" variant="outline" className="h-7 text-xs" onClick={() => info.refetch()}><RefreshCw className="w-3 h-3" /> 重试</Button>
      </div>
    )
  }

  const d: StorageInfo | undefined = info.data
  const smartByDev = new Map((d?.smart ?? []).map((s) => [s.device, s.health]))

  return (
    <div className="flex flex-col h-full">
      {dialog}
      <header className="flex items-center justify-between gap-2 px-3 py-2 border-b bg-card">
        <div className="flex items-center gap-2 min-w-0">
          <HardDrive className="w-4 h-4 text-primary shrink-0" />
          <span className="text-xs font-medium">存储与磁盘</span>
        </div>
        <Button variant="ghost" size="icon" className="h-7 w-7" onClick={() => info.refetch()} title="刷新">
          <RefreshCw className={cn("w-3 h-3", info.isFetching && "animate-spin")} />
        </Button>
      </header>

      <div className="flex-1 overflow-auto p-3 space-y-3">
        {!d ? (
          <div className="text-xs text-muted-foreground inline-flex items-center gap-2 py-4"><Loader2 className="w-3 h-3 animate-spin" /> 采集中…</div>
        ) : (
          <>
            {/* Filesystem capacity */}
            <section className="space-y-2">
              <h3 className="text-[10px] font-medium uppercase tracking-wide text-muted-foreground px-0.5">文件系统</h3>
              {d.filesystems.map((f) => (
                <Card key={f.mount}>
                  <CardContent className="px-3 py-2 space-y-1.5">
                    <div className="flex items-center justify-between text-xs gap-2">
                      <span className="font-mono truncate" title={`${f.mount} (${f.source})`}>{f.mount}</span>
                      <span className={cn("tabular-nums font-medium", usagePctTone(f.use_pct))}>{f.use_pct}%</span>
                    </div>
                    <Progress value={Math.min(100, f.use_pct)} className="h-1.5" indicatorClassName={usagePctBg(f.use_pct)} />
                    <div className="flex justify-between text-[10px] text-muted-foreground tabular-nums">
                      <span>{formatBytes(f.used_kb)} / {formatBytes(f.size_kb)}</span>
                      <span className={f.inode_pct >= 90 ? "text-destructive" : ""}>inode {f.inode_pct}%</span>
                    </div>
                  </CardContent>
                </Card>
              ))}
            </section>

            {/* Block devices */}
            <Card>
              <CardHeader className="py-2 px-3 space-y-0"><CardTitle className="text-xs font-medium">块设备</CardTitle></CardHeader>
              <CardContent className="px-3 pb-3 pt-0 space-y-0.5">
                {d.devices.map((dev) => <DeviceNode key={dev.name} d={dev} depth={0} smart={smartByDev} />)}
                {d.devices.length === 0 && <span className="text-[11px] text-muted-foreground">lsblk 不可用</span>}
              </CardContent>
            </Card>

            {/* fstab */}
            {(d.fstab?.length ?? 0) > 0 && (
              <Card>
                <CardHeader className="py-2 px-3 space-y-0"><CardTitle className="text-xs font-medium">fstab 挂载</CardTitle></CardHeader>
                <CardContent className="px-0 pb-1 pt-0">
                  <table className="w-full text-[11px]">
                    <tbody className="divide-y divide-border/40">
                      {d.fstab!.map((e, i) => {
                        const isMounted = mountedSet.has(e.mount)
                        return (
                          <tr key={i} className="hover:bg-muted/50">
                            <td className="px-3 py-1 font-mono truncate max-w-[8rem]" title={e.mount}>{e.mount}</td>
                            <td className="px-2 py-1 text-muted-foreground">{e.fstype}</td>
                            <td className="px-2 py-1">
                              {isMounted ? <Badge variant="success" className="text-[10px]">已挂载</Badge> : <Badge variant="secondary" className="text-[10px]">未挂载</Badge>}
                            </td>
                            <td className="px-3 py-1 text-right">
                              {isMounted ? (
                                <Button variant="ghost" size="icon" className="h-6 w-6" title="卸载" disabled={mount.isPending || e.mount === "/"} onClick={() => onMountOp(e.mount, true)}>
                                  <Unplug className="w-3 h-3" />
                                </Button>
                              ) : (
                                <Button variant="ghost" size="icon" className="h-6 w-6" title="挂载" disabled={mount.isPending} onClick={() => onMountOp(e.mount, false)}>
                                  <Plug className="w-3 h-3" />
                                </Button>
                              )}
                            </td>
                          </tr>
                        )
                      })}
                    </tbody>
                  </table>
                </CardContent>
              </Card>
            )}

            {d.lvm && d.lvm.replace(/#\s*(PV|VG|LV)/g, "").trim() && (
              <Collapsible>
                <Card>
                  <CollapsibleTrigger className="w-full">
                    <CardHeader className="py-2 px-3 space-y-0"><CardTitle className="text-xs font-medium text-left">LVM</CardTitle></CardHeader>
                  </CollapsibleTrigger>
                  <CollapsibleContent>
                    <CardContent className="px-3 pb-3 pt-0">
                      <pre className="font-mono text-[10px] whitespace-pre overflow-x-auto max-h-60">{d.lvm}</pre>
                    </CardContent>
                  </CollapsibleContent>
                </Card>
              </Collapsible>
            )}
          </>
        )}
      </div>
    </div>
  )
}

function DeviceNode({ d, depth, smart }: { d: StBlockDevice; depth: number; smart: Map<string, string> }) {
  const health = smart.get(d.name)
  return (
    <>
      <div className="flex items-center gap-2 text-[11px] py-0.5" style={{ paddingLeft: depth * 14 }}>
        <HardDrive className={cn("w-3 h-3 shrink-0", d.type === "disk" ? "text-foreground" : "text-muted-foreground")} />
        <span className="font-mono">{d.name}</span>
        <Badge variant="outline" className="text-[9px] px-1 h-4">{d.type}</Badge>
        <span className="text-muted-foreground">{d.size}</span>
        {d.fstype && <span className="text-muted-foreground">{d.fstype}</span>}
        {d.mountpoint && <span className="font-mono text-primary truncate">{d.mountpoint}</span>}
        {health && (
          <Badge variant={health === "PASSED" ? "success" : health === "FAILED" ? "destructive" : "secondary"} className="text-[9px] px-1 h-4 ml-auto">
            SMART {health}
          </Badge>
        )}
      </div>
      {(d.children ?? []).map((c) => <DeviceNode key={c.name} d={c} depth={depth + 1} smart={smart} />)}
    </>
  )
}
