"use client"

// Credentials — the flagship redesigned admin surface. Editorial serif title,
// searchable rich table (type / tags / expiry / last-used / usage), inline
// edit + connectivity test, and a reference-aware delete dialog that shows
// exactly which nodes/proxies break before you remove a credential.

import * as React from "react"
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query"
import {
  FileKey2,
  KeyRound,
  Lock,
  Pencil,
  Plus,
  Search,
  Server,
  Trash2,
  Loader2,
  Network,
  AlertTriangle,
} from "lucide-react"
import { toast } from "@/components/ui/sonner"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import {
  AlertDialog,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog"
import { DataTable, type Column } from "@/components/common/data-table"
import { EmptyState } from "@/components/common/empty-state"
import { CredentialFormSheet } from "@/components/admin/credential-form-sheet"
import { credentialService } from "@/lib/api/services"
import type { Credential } from "@/lib/api/types"

const KEY = ["admin", "credentials"] as const

export default function CredentialsPage() {
  const qc = useQueryClient()
  const q = useQuery({ queryKey: KEY, queryFn: credentialService.list })
  const [search, setSearch] = React.useState("")
  const [editing, setEditing] = React.useState<Credential | null>(null)
  const [deleting, setDeleting] = React.useState<Credential | null>(null)

  const invalidate = () => qc.invalidateQueries({ queryKey: KEY })

  const all = q.data?.credentials ?? []
  const rows = React.useMemo(() => {
    const s = search.trim().toLowerCase()
    if (!s) return all
    return all.filter((c) =>
      [c.name, c.username, c.tags, c.description].filter(Boolean).join(" ").toLowerCase().includes(s),
    )
  }, [all, search])

  const columns: Column<Credential>[] = [
    {
      header: "名称",
      cell: (c) => (
        <div className="min-w-0">
          <div className="font-medium">{c.name}</div>
          {c.description && (
            <div className="truncate text-xs text-muted-foreground" title={c.description}>
              {c.description}
            </div>
          )}
        </div>
      ),
    },
    { header: "类型", cell: (c) => <KindBadge kind={c.kind} /> },
    {
      header: "用户名",
      cell: (c) =>
        c.username ? (
          <span className="font-mono text-xs">{c.username}</span>
        ) : (
          <span className="text-muted-foreground">—</span>
        ),
    },
    { header: "标签", cell: (c) => <TagCells tags={c.tags} /> },
    { header: "过期", cell: (c) => <ExpiryCell iso={c.expires_at} /> },
    {
      header: "最近使用",
      cell: (c) => <span className="text-xs text-muted-foreground">{relTime(c.last_used_at)}</span>,
    },
    { header: "用量", cell: (c) => <UsageCell nodes={c.usage_nodes} proxies={c.usage_proxies} /> },
    {
      header: "操作",
      className: "text-right",
      cell: (c) => (
        <div className="flex items-center justify-end gap-0.5">
          <Button variant="ghost" size="icon" className="h-8 w-8" aria-label="编辑" onClick={() => setEditing(c)}>
            <Pencil className="h-4 w-4" />
          </Button>
          <Button
            variant="ghost"
            size="icon"
            className="h-8 w-8"
            aria-label="删除"
            onClick={() => setDeleting(c)}
          >
            <Trash2 className="h-4 w-4 text-destructive" />
          </Button>
        </div>
      ),
    },
  ]

  const showEmpty = !q.isLoading && all.length === 0

  return (
    <div className="space-y-6 p-6">
      {/* Header */}
      <div className="flex flex-wrap items-end justify-between gap-4">
        <div className="space-y-1">
          <h1 className="display-title flex items-center gap-2.5 text-3xl">
            <span className="flex h-9 w-9 items-center justify-center rounded-lg bg-primary/12 text-primary">
              <KeyRound className="h-5 w-5" />
            </span>
            凭据
          </h1>
          <p className="max-w-xl text-sm text-muted-foreground">
            集中托管密码与 SSH 私钥，AEAD 信封加密落库。节点登录、SSH 跳板、SOCKS5 鉴权都从这里取用身份。
          </p>
        </div>
        <CredentialFormSheet
          trigger={
            <Button>
              <Plus className="h-4 w-4" /> 新增凭据
            </Button>
          }
          onSaved={invalidate}
        />
      </div>

      {!showEmpty && (
        <>
          {/* Toolbar */}
          <div className="flex items-center justify-between gap-3">
            <div className="relative w-full max-w-xs">
              <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
              <Input
                value={search}
                onChange={(e) => setSearch(e.target.value)}
                placeholder="搜索名称 / 用户名 / 标签…"
                className="pl-9"
              />
            </div>
            <span className="shrink-0 text-xs text-muted-foreground">
              共 {all.length} 条{search && `，匹配 ${rows.length} 条`}
            </span>
          </div>

          <DataTable
            columns={columns}
            rows={rows}
            loading={q.isLoading}
            empty={search ? "没有匹配的凭据" : "暂无凭据"}
          />
        </>
      )}

      {showEmpty && (
        <div className="rounded-xl border bg-card">
          <EmptyState
            icon={KeyRound}
            title="还没有任何凭据"
            description="创建第一条凭据后，即可在节点、SSH 跳板代理、SOCKS5 鉴权中引用它。密码与私钥都会加密存储。"
            action={
              <CredentialFormSheet
                trigger={
                  <Button>
                    <Plus className="h-4 w-4" /> 创建第一条凭据
                  </Button>
                }
                onSaved={invalidate}
              />
            }
          />
        </div>
      )}

      {/* Edit */}
      {editing && (
        <CredentialFormSheet
          mode="edit"
          credential={editing}
          open
          onOpenChange={(v) => !v && setEditing(null)}
          onSaved={() => {
            invalidate()
            setEditing(null)
          }}
        />
      )}

      {/* Delete with reference awareness */}
      {deleting && (
        <DeleteCredentialDialog
          credential={deleting}
          onOpenChange={(v) => !v && setDeleting(null)}
          onDeleted={() => {
            invalidate()
            setDeleting(null)
          }}
        />
      )}
    </div>
  )
}

// ---------- cells ----------

function KindBadge({ kind }: { kind: Credential["kind"] }) {
  if (kind === "private_key") {
    return (
      <Badge variant="soft" className="gap-1 font-normal">
        <FileKey2 className="h-3 w-3" /> SSH 私钥
      </Badge>
    )
  }
  if (kind === "agent") {
    return (
      <Badge variant="outline" className="gap-1 font-normal">
        <KeyRound className="h-3 w-3" /> Agent
      </Badge>
    )
  }
  return (
    <Badge variant="soft" className="gap-1 font-normal">
      <Lock className="h-3 w-3" /> 密码
    </Badge>
  )
}

function TagCells({ tags }: { tags?: string }) {
  const list = (tags || "")
    .split(",")
    .map((t) => t.trim())
    .filter(Boolean)
  if (list.length === 0) return <span className="text-muted-foreground">—</span>
  const shown = list.slice(0, 3)
  return (
    <div className="flex flex-wrap gap-1">
      {shown.map((t) => (
        <Badge key={t} variant="outline" className="rounded-full font-normal">
          {t}
        </Badge>
      ))}
      {list.length > shown.length && (
        <Badge variant="outline" className="rounded-full font-normal text-muted-foreground">
          +{list.length - shown.length}
        </Badge>
      )}
    </div>
  )
}

function ExpiryCell({ iso }: { iso?: string | null }) {
  if (!iso) return <span className="text-muted-foreground">—</span>
  const t = new Date(iso).getTime()
  if (Number.isNaN(t)) return <span className="text-muted-foreground">—</span>
  const days = Math.ceil((t - Date.now()) / 86400000)
  if (days < 0) return <Badge variant="destructive" className="font-normal">已过期</Badge>
  if (days <= 14)
    return (
      <Badge variant="warning" className="font-normal">
        {days} 天后到期
      </Badge>
    )
  return <span className="text-xs text-muted-foreground">{iso.slice(0, 10)}</span>
}

function UsageCell({ nodes, proxies }: { nodes?: number; proxies?: number }) {
  const n = nodes ?? 0
  const p = proxies ?? 0
  if (n === 0 && p === 0) return <span className="text-xs text-muted-foreground">未使用</span>
  return (
    <div className="flex flex-wrap gap-1">
      {n > 0 && (
        <Badge variant="coral" className="gap-1 font-normal">
          <Server className="h-3 w-3" /> {n} 节点
        </Badge>
      )}
      {p > 0 && (
        <Badge variant="coral" className="gap-1 font-normal">
          <Network className="h-3 w-3" /> {p} 代理
        </Badge>
      )}
    </div>
  )
}

// ---------- delete dialog (reference-aware) ----------

function DeleteCredentialDialog({
  credential,
  onOpenChange,
  onDeleted,
}: {
  credential: Credential
  onOpenChange: (v: boolean) => void
  onDeleted: () => void
}) {
  const usage = useQuery({
    queryKey: ["credential-usage", credential.id],
    queryFn: () => credentialService.usage(credential.id),
  })
  const refCount = (usage.data?.nodes.length ?? 0) + (usage.data?.proxies.length ?? 0)
  const inUse = refCount > 0

  const del = useMutation({
    mutationFn: () => credentialService.remove(credential.id, { force: inUse }),
    onSuccess: () => {
      toast.success("凭据已删除")
      onDeleted()
    },
    onError: (e: Error) => toast.error("删除失败", { description: e.message }),
  })

  return (
    <AlertDialog open onOpenChange={onOpenChange}>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle className="flex items-center gap-2">
            <Trash2 className="h-4 w-4 text-destructive" />
            删除凭据「{credential.name}」？
          </AlertDialogTitle>
          <AlertDialogDescription asChild>
            <div className="space-y-3 pt-1">
              {usage.isLoading ? (
                <span className="flex items-center gap-2 text-sm text-muted-foreground">
                  <Loader2 className="h-3.5 w-3.5 animate-spin" /> 正在检查引用…
                </span>
              ) : inUse ? (
                <>
                  <div className="flex items-start gap-2 rounded-md border border-amber-500/30 bg-amber-500/10 p-2.5 text-amber-700 dark:text-amber-300">
                    <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" />
                    <span className="text-sm">
                      仍有 <b>{refCount}</b> 处在引用该凭据。强制删除后，这些目标将无法用此凭据登录。
                    </span>
                  </div>
                  <UsageList usage={usage.data} />
                </>
              ) : (
                <span className="text-sm text-muted-foreground">该凭据当前未被任何节点或代理引用，可安全删除。</span>
              )}
            </div>
          </AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)} disabled={del.isPending}>
            取消
          </Button>
          <Button
            className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
            disabled={del.isPending || usage.isLoading}
            onClick={() => del.mutate()}
          >
            {del.isPending && <Loader2 className="h-4 w-4 animate-spin" />}
            {inUse ? "仍要强制删除" : "删除"}
          </Button>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  )
}

function UsageList({ usage }: { usage?: { nodes: { id: number; name: string; host: string; kind?: string }[]; proxies: { id: number; name: string; host: string; kind?: string }[] } }) {
  if (!usage) return null
  return (
    <div className="max-h-48 space-y-1.5 overflow-y-auto rounded-md border bg-secondary/40 p-2 text-sm">
      {usage.nodes.map((n) => (
        <div key={`n-${n.id}`} className="flex items-center gap-2">
          <Server className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
          <span className="font-medium">{n.name}</span>
          <span className="truncate text-xs text-muted-foreground">
            {n.host} · {n.kind}
          </span>
        </div>
      ))}
      {usage.proxies.map((p) => (
        <div key={`p-${p.id}`} className="flex items-center gap-2">
          <Network className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
          <span className="font-medium">{p.name}</span>
          <span className="truncate text-xs text-muted-foreground">
            {p.host} · {p.kind}
          </span>
        </div>
      ))}
    </div>
  )
}

// ---------- util ----------

function relTime(iso?: string | null): string {
  if (!iso) return "从未"
  const t = new Date(iso).getTime()
  if (Number.isNaN(t)) return "—"
  const sec = Math.floor((Date.now() - t) / 1000)
  if (sec < 0) return "刚刚"
  if (sec < 60) return "刚刚"
  const min = Math.floor(sec / 60)
  if (min < 60) return `${min} 分钟前`
  const hr = Math.floor(min / 60)
  if (hr < 24) return `${hr} 小时前`
  const day = Math.floor(hr / 24)
  if (day < 30) return `${day} 天前`
  const mon = Math.floor(day / 30)
  if (mon < 12) return `${mon} 个月前`
  return `${Math.floor(mon / 12)} 年前`
}
