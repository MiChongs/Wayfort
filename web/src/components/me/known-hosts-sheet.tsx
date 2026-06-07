"use client"

// Phase 12 — Known Hosts management Sheet.
//
// 列出该用户的已接受 SSH 服务器指纹;支持手动 revoke / re-trust,加可选备注。
// 自动接受流程(TOFU)由 dialer 端写入,这里只是审计 + 撤销入口。

import * as React from "react"
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query"
import { Loader2, RotateCw, ShieldCheck, ShieldX, Sparkles } from "lucide-react"
import { toast } from "@/components/ui/sonner"
import { cn } from "@/lib/utils"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Card, CardContent } from "@/components/ui/card"
import { Input } from "@/components/ui/input"
import { ScrollArea } from "@/components/ui/scroll-area"
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
  SheetTrigger,
} from "@/components/ui/sheet"
import { ConfirmDeleteIconButton } from "@/components/admin/confirm-delete"
import { knownHostService } from "@/lib/api/services"

export function KnownHostsSheet({ trigger }: { trigger?: React.ReactNode }) {
  const [open, setOpen] = React.useState(false)
  const [q, setQ] = React.useState("")
  const qc = useQueryClient()
  const list = useQuery({
    queryKey: ["me", "known-hosts"],
    queryFn: knownHostService.list,
    enabled: open,
  })
  const setStatus = useMutation({
    mutationFn: ({ id, status }: { id: number; status: "trusted" | "revoked" }) =>
      knownHostService.update(id, { status }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["me", "known-hosts"] }),
  })
  const remove = useMutation({
    mutationFn: (id: number) => knownHostService.remove(id),
    onSuccess: () => {
      toast.success("已删除")
      qc.invalidateQueries({ queryKey: ["me", "known-hosts"] })
    },
  })

  const rows = list.data?.hosts || []
  const filtered = React.useMemo(() => {
    const t = q.trim().toLowerCase()
    if (!t) return rows
    return rows.filter(
      (h) =>
        h.host_addr.toLowerCase().includes(t) ||
        h.fingerprint.toLowerCase().includes(t) ||
        (h.notes || "").toLowerCase().includes(t),
    )
  }, [rows, q])

  return (
    <Sheet open={open} onOpenChange={setOpen}>
      <SheetTrigger asChild>
        {trigger || (
          <Button variant="outline" size="sm">
            <ShieldCheck className="h-3.5 w-3.5" /> 已知主机
          </Button>
        )}
      </SheetTrigger>
      <SheetContent side="right" className="flex w-full flex-col gap-0 p-0 sm:max-w-[520px]">
        <SheetHeader className="border-b px-6 pt-6 pb-4">
          <SheetTitle className="flex items-center gap-2 text-base">
            <ShieldCheck className="h-4 w-4" /> 已知 SSH 主机
          </SheetTitle>
          <SheetDescription>
            管理已接受的服务器 SSH 主机密钥;撤销后再次连接会重新提示信任。
          </SheetDescription>
        </SheetHeader>
        <div className="border-b bg-muted/20 px-6 py-3">
          <Input
            placeholder="搜索 host / fingerprint / 备注..."
            value={q}
            onChange={(e) => setQ(e.target.value)}
            className="h-8"
          />
        </div>
        <ScrollArea className="min-h-0 flex-1 px-6 py-4">
          {list.isLoading ? (
            <div className="flex items-center gap-2 px-3 py-3 text-xs text-muted-foreground">
              <Loader2 className="h-3.5 w-3.5 animate-spin" /> 加载中...
            </div>
          ) : filtered.length === 0 ? (
            <div className="flex flex-col items-center gap-2 px-3 py-10 text-center text-xs text-muted-foreground">
              <Sparkles className="h-6 w-6 opacity-60" />
              {rows.length === 0 ? (
                <p>暂无记录。首次连接 SSH 节点时,接受的指纹会自动出现在这里。</p>
              ) : (
                <p>无匹配结果</p>
              )}
            </div>
          ) : (
            <div className="space-y-2">
              {filtered.map((h) => (
                <Card key={h.id} className={cn(h.status === "revoked" && "border-destructive/40 bg-destructive/5")}>
                  <CardContent className="space-y-2 p-3">
                    <div className="flex items-center justify-between gap-2">
                      <div className="flex min-w-0 items-center gap-1.5">
                        <span className="truncate font-mono text-xs font-medium">{h.host_addr}</span>
                        <Badge variant="outline" className="font-normal">{h.host_key_type}</Badge>
                        <Badge
                          variant="outline"
                          className={cn(
                            "font-normal",
                            h.status === "trusted" &&
                              "border-emerald-500/30 bg-emerald-500/10 text-emerald-600 dark:text-emerald-300",
                            h.status === "revoked" &&
                              "border-destructive/30 bg-destructive/10 text-destructive",
                          )}
                        >
                          {h.status === "trusted" ? "已信任" : "已撤销"}
                        </Badge>
                      </div>
                      <div className="flex items-center gap-0.5">
                        {h.status === "trusted" ? (
                          <Button
                            size="icon"
                            variant="ghost"
                            className="h-6 w-6 text-destructive"
                            title="撤销信任"
                            onClick={() => setStatus.mutate({ id: h.id, status: "revoked" })}
                            disabled={setStatus.isPending}
                          >
                            <ShieldX className="h-3 w-3" />
                          </Button>
                        ) : (
                          <Button
                            size="icon"
                            variant="ghost"
                            className="h-6 w-6 text-emerald-500"
                            title="恢复信任"
                            onClick={() => setStatus.mutate({ id: h.id, status: "trusted" })}
                            disabled={setStatus.isPending}
                          >
                            <RotateCw className="h-3 w-3" />
                          </Button>
                        )}
                        <ConfirmDeleteIconButton
                          className="h-6 w-6"
                          iconClassName="h-3 w-3"
                          title={`删除指纹记录 ${h.host_addr}?`}
                          description="下次连接将作为新主机重新提示。"
                          loading={remove.isPending}
                          onConfirm={() => remove.mutate(h.id)}
                        />
                      </div>
                    </div>
                    <pre className="overflow-x-auto rounded bg-muted/30 px-2 py-1 font-mono text-[10px]">
                      {h.fingerprint}
                    </pre>
                    <div className="flex flex-wrap items-center gap-2 text-[10px] text-muted-foreground">
                      <span>{new Date(h.accepted_at).toLocaleString()}</span>
                      {h.last_seen_at && <span>· 最近 {new Date(h.last_seen_at).toLocaleDateString()}</span>}
                      {h.notes && <span>· {h.notes}</span>}
                    </div>
                  </CardContent>
                </Card>
              ))}
            </div>
          )}
        </ScrollArea>
      </SheetContent>
    </Sheet>
  )
}
