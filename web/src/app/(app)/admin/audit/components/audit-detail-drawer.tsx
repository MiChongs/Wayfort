"use client"

import * as React from "react"
import Link from "next/link"
import {
  Clapperboard,
  Copy,
  Filter,
  Globe,
  Hash,
  Server,
  TerminalSquare,
  User,
} from "lucide-react"
import type { AuditLogRow } from "@/lib/api/types"
import {
  Sheet,
  SheetContent,
  SheetHeader,
  SheetTitle,
} from "@/components/ui/sheet"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { toast } from "@/components/ui/sonner"
import { fullTime, relTime } from "@/lib/format"
import { auditMeta, categoryMeta, auditSeverity } from "@/lib/session-meta"
import { cn } from "@/lib/utils"

export interface AuditDetailDrawerProps {
  row: AuditLogRow | null
  onClose: () => void
  onPickUser: (name: string) => void
  onPickNode: (name: string) => void
  onPickIp: (ip: string) => void
}

function copy(text: string, what: string) {
  if (!text) return
  navigator.clipboard?.writeText(text).then(
    () => toast.success(`已复制${what}`),
    () => toast.error("复制失败"),
  )
}

export function AuditDetailDrawer({ row, onClose, onPickUser, onPickNode, onPickIp }: AuditDetailDrawerProps) {
  const open = !!row
  // Retain the last row so the body — and its SheetTitle — stays mounted through
  // the close animation (Radix warns if DialogContent ever lacks a title).
  const [shown, setShown] = React.useState<AuditLogRow | null>(row)
  React.useEffect(() => {
    if (row) setShown(row)
  }, [row])
  return (
    <Sheet open={open} onOpenChange={(o) => { if (!o) onClose() }}>
      <SheetContent side="right" className="flex w-full flex-col gap-0 overflow-y-auto sm:max-w-xl">
        {shown && <DrawerBody row={shown} onPickUser={onPickUser} onPickNode={onPickNode} onPickIp={onPickIp} />}
      </SheetContent>
    </Sheet>
  )
}

function DrawerBody({ row, onPickUser, onPickNode, onPickIp }: { row: AuditLogRow } & Omit<AuditDetailDrawerProps, "row" | "onClose">) {
  const meta = auditMeta(row.kind)
  const cat = categoryMeta(row.category)
  const sev = auditSeverity(row)
  const Icon = meta.icon
  const isCommand = row.kind === "command"

  return (
    <>
      <SheetHeader className="gap-2 pr-8">
        <div className="flex items-center gap-2">
          <span className={cn(
            "grid h-9 w-9 shrink-0 place-items-center rounded-lg",
            sev === "danger" ? "bg-destructive/12 text-destructive" : "bg-primary/12 text-primary",
          )}>
            <Icon className="h-4.5 w-4.5" />
          </span>
          <div className="min-w-0">
            <SheetTitle className="flex items-center gap-2 text-base">
              {meta.label}
              <Badge variant={cat.tone}>{cat.label}</Badge>
              {sev === "danger" && <Badge variant="destructive">异常</Badge>}
              {sev === "warn" && <Badge variant="warning">关注</Badge>}
            </SheetTitle>
            <p className="mt-0.5 text-xs text-muted-foreground">
              {fullTime(row.created_at)} · {relTime(row.created_at)} · 事件 #{row.id}
            </p>
          </div>
        </div>
      </SheetHeader>

      {/* Metadata grid */}
      <div className="mt-4 grid grid-cols-2 gap-2">
        <MetaItem icon={User} label="用户" value={row.username || "—"} onCopy={() => copy(row.username, "用户名")} onFilter={row.username ? () => onPickUser(row.username) : undefined} />
        <MetaItem icon={Globe} label="来源 IP" value={row.client_ip || "—"} mono onCopy={() => copy(row.client_ip || "", "IP")} onFilter={row.client_ip ? () => onPickIp(row.client_ip!) : undefined} />
        <MetaItem icon={Server} label="资产" value={row.node_name || (row.node_id ? `#${row.node_id}` : "—")} onCopy={row.node_name ? () => copy(row.node_name!, "资产名") : undefined} onFilter={row.node_name ? () => onPickNode(row.node_name!) : undefined} />
        <MetaItem icon={Hash} label="会话" value={row.session_id ? `${row.session_id.slice(0, 12)}…` : "—"} mono onCopy={row.session_id ? () => copy(row.session_id!, "会话 ID") : undefined} />
      </div>

      {/* Session jump */}
      {row.session_id && (
        <Link
          href={`/sessions/${row.session_id}` as Parameters<typeof Link>[0]["href"]}
          className="mt-2 inline-flex items-center gap-1.5 text-xs text-primary hover:underline"
        >
          <Clapperboard className="h-3.5 w-3.5" /> 查看会话详情与回放
        </Link>
      )}

      {/* Command decode / payload */}
      {row.payload ? (
        <div className="mt-4 space-y-1.5">
          <div className="flex items-center justify-between">
            <span className="flex items-center gap-1.5 text-xs font-medium text-muted-foreground">
              <TerminalSquare className="h-3.5 w-3.5" /> {isCommand ? "命令原文" : "事件详情"}
            </span>
            <button
              type="button"
              onClick={() => copy(row.payload || "", isCommand ? "命令" : "详情")}
              className="inline-flex items-center gap-1 rounded-md px-1.5 py-0.5 text-xs text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
            >
              <Copy className="h-3 w-3" /> 复制
            </button>
          </div>
          <pre className={cn(
            "max-h-72 overflow-auto rounded-lg border bg-muted/40 p-3 font-mono text-xs leading-relaxed",
            sev === "danger" && isCommand && "border-destructive/40 text-destructive",
          )}>
            {row.payload}
          </pre>
          {sev === "danger" && isCommand && (
            <p className="text-[11px] text-destructive">该命令命中危险模式，已标记为异常。</p>
          )}
        </div>
      ) : (
        <p className="mt-4 text-xs text-muted-foreground">此事件没有附加详情。</p>
      )}

      {/* Quick filter actions */}
      <div className="mt-auto flex flex-wrap gap-2 pt-5">
        {row.username && (
          <Button variant="outline" size="sm" onClick={() => onPickUser(row.username)}>
            <Filter className="h-3.5 w-3.5" /> 筛此用户
          </Button>
        )}
        {row.node_name && (
          <Button variant="outline" size="sm" onClick={() => onPickNode(row.node_name!)}>
            <Filter className="h-3.5 w-3.5" /> 筛此资产
          </Button>
        )}
        {row.client_ip && (
          <Button variant="outline" size="sm" onClick={() => onPickIp(row.client_ip!)}>
            <Filter className="h-3.5 w-3.5" /> 筛此 IP
          </Button>
        )}
      </div>
    </>
  )
}

function MetaItem({
  icon: Icon, label, value, mono, onCopy, onFilter,
}: {
  icon: React.ComponentType<{ className?: string }>
  label: string
  value: string
  mono?: boolean
  onCopy?: () => void
  onFilter?: () => void
}) {
  return (
    <div className="group rounded-lg border bg-card p-2.5">
      <div className="flex items-center gap-1 text-[10px] uppercase tracking-wide text-muted-foreground">
        <Icon className="h-3 w-3" /> {label}
      </div>
      <div className="mt-1 flex items-center justify-between gap-1">
        <span className={cn("min-w-0 truncate text-sm", mono && "font-mono text-xs")} title={value}>{value}</span>
        <span className="flex shrink-0 items-center gap-0.5 opacity-0 transition-opacity group-hover:opacity-100">
          {onFilter && (
            <button type="button" onClick={onFilter} className="rounded p-1 text-muted-foreground hover:bg-accent hover:text-foreground" title="按此筛选">
              <Filter className="h-3 w-3" />
            </button>
          )}
          {onCopy && (
            <button type="button" onClick={onCopy} className="rounded p-1 text-muted-foreground hover:bg-accent hover:text-foreground" title="复制">
              <Copy className="h-3 w-3" />
            </button>
          )}
        </span>
      </div>
    </div>
  )
}
