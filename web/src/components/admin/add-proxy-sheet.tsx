"use client"

// AddProxySheet — Phase 10 Sheet-based replacement for the legacy CreateProxy
// Dialog. Renders a smart, per-kind form: the field set adapts to the proxy
// kind (direct hides host/port, bastion requires credential, etc.) and uses
// the same shadcn primitives as the rest of the admin surface.

import * as React from "react"
import { useMutation } from "@tanstack/react-query"
import { KeyRound, Loader2, Network, Plus, Tag } from "lucide-react"
import { toast } from "sonner"
import { cn } from "@/lib/utils"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { ScrollArea } from "@/components/ui/scroll-area"
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select"
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetFooter,
  SheetHeader,
  SheetTitle,
  SheetTrigger,
} from "@/components/ui/sheet"
import { Switch } from "@/components/ui/switch"
import { Textarea } from "@/components/ui/textarea"
import { proxyService } from "@/lib/api/services"
import type { Proxy, ProxyKind } from "@/lib/api/types"

const KIND_OPTIONS: {
  kind: ProxyKind
  label: string
  port: number
  description: string
  needs: { host: boolean; port: boolean; credential: boolean }
}[] = [
  {
    kind: "direct",
    label: "Direct",
    port: 0,
    description: "占位 hop。用于把网关本身夹在链中(几乎不需要),或作为模板末端。",
    needs: { host: false, port: false, credential: false },
  },
  {
    kind: "socks5",
    label: "SOCKS5",
    port: 1080,
    description: "经典 SOCKS5 出口。可选凭据用于用户名/密码鉴权。",
    needs: { host: true, port: true, credential: false },
  },
  {
    kind: "bastion",
    label: "SSH 跳板",
    port: 22,
    description: "通过 SSH 客户端登录跳板机,再从跳板机 dial 后续 hop。必须绑定凭据。",
    needs: { host: true, port: true, credential: true },
  },
  {
    kind: "http_connect",
    label: "HTTP CONNECT",
    port: 8080,
    description: "HTTP/1.1 CONNECT 代理。常用于 corp egress。",
    needs: { host: true, port: true, credential: false },
  },
]

export interface AddProxySheetProps {
  credentials: { id: number; name: string }[]
  onCreated: () => void
}

export function AddProxySheet({ credentials, onCreated }: AddProxySheetProps) {
  const [open, setOpen] = React.useState(false)
  const [p, setP] = React.useState<Partial<Proxy> & { credential_id?: number }>(initialDraft())

  React.useEffect(() => {
    if (open) setP(initialDraft())
  }, [open])

  const kindMeta = KIND_OPTIONS.find((k) => k.kind === p.kind) || KIND_OPTIONS[1]

  const create = useMutation({
    mutationFn: () => proxyService.create(p as Proxy),
    onSuccess: () => {
      toast.success("代理已创建")
      setOpen(false)
      onCreated()
    },
    onError: (e: Error) => toast.error("创建失败", { description: e.message }),
  })

  const canCreate =
    !!p.name?.trim() &&
    (!kindMeta.needs.host || (!!p.host?.trim() && (p.port || 0) > 0)) &&
    (!kindMeta.needs.credential || !!p.credential_id) &&
    !create.isPending

  return (
    <Sheet open={open} onOpenChange={setOpen}>
      <SheetTrigger asChild>
        <Button>
          <Plus className="h-4 w-4" /> 新建代理
        </Button>
      </SheetTrigger>
      <SheetContent side="right" className="flex w-full flex-col gap-0 p-0 sm:max-w-md">
        <SheetHeader className="border-b px-6 pt-6 pb-4">
          <SheetTitle className="flex items-center gap-2 text-base">
            <Network className="h-4 w-4" /> 新建代理 hop
          </SheetTitle>
          <SheetDescription>
            添加一个新的代理 hop;创建后可在代理链构建器中插入任意节点的链路。
          </SheetDescription>
        </SheetHeader>

        <ScrollArea className="min-h-0 flex-1 px-6 py-4">
          <div className="space-y-4">
            <div className="space-y-1.5">
              <Label className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
                类型
              </Label>
              <div className="grid grid-cols-2 gap-2">
                {KIND_OPTIONS.map((opt) => (
                  <button
                    key={opt.kind}
                    type="button"
                    onClick={() => setP({ ...p, kind: opt.kind, port: opt.port })}
                    className={cn(
                      "rounded-md border bg-card p-3 text-left transition-colors hover:bg-muted/60 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
                      p.kind === opt.kind && "border-primary ring-1 ring-primary",
                    )}
                  >
                    <div className="flex items-center justify-between">
                      <span className="text-sm font-medium">{opt.label}</span>
                      <Badge variant="outline" className="text-[10px] font-normal">
                        :{opt.port || "—"}
                      </Badge>
                    </div>
                    <p className="mt-1 text-[11px] leading-relaxed text-muted-foreground">{opt.description}</p>
                  </button>
                ))}
              </div>
            </div>

            <Field label="名称" required>
              <Input
                value={p.name || ""}
                onChange={(e) => setP({ ...p, name: e.target.value })}
                placeholder="如:hkg-egress-socks5"
              />
            </Field>

            {kindMeta.needs.host && (
              <div className="grid grid-cols-3 gap-3">
                <Field label="主机" className="col-span-2" required>
                  <Input
                    value={p.host || ""}
                    onChange={(e) => setP({ ...p, host: e.target.value })}
                    placeholder="hostname / IP"
                  />
                </Field>
                <Field label="端口" required>
                  <Input
                    type="number"
                    value={p.port || 0}
                    onChange={(e) => setP({ ...p, port: Number(e.target.value) })}
                  />
                </Field>
              </div>
            )}

            <Field label={kindMeta.needs.credential ? "凭据 (必填)" : "凭据 (可选)"}>
              <Select
                value={p.credential_id ? String(p.credential_id) : "_none"}
                onValueChange={(v) =>
                  setP({ ...p, credential_id: v === "_none" ? undefined : Number(v) })
                }
              >
                <SelectTrigger>
                  <SelectValue placeholder="选择凭据" />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="_none">
                    <span className="text-muted-foreground">— 不绑定 —</span>
                  </SelectItem>
                  {credentials.map((c) => (
                    <SelectItem key={c.id} value={String(c.id)}>
                      <div className="flex items-center gap-2">
                        <KeyRound className="h-3.5 w-3.5 text-muted-foreground" />
                        {c.name}
                      </div>
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </Field>

            <Field label="标签 (逗号分隔)">
              <div className="relative">
                <Tag className="pointer-events-none absolute left-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-muted-foreground" />
                <Input
                  className="pl-8"
                  value={p.tags || ""}
                  onChange={(e) => setP({ ...p, tags: e.target.value })}
                  placeholder="asia, audit-only"
                />
              </div>
            </Field>

            <Field label="说明">
              <Textarea
                rows={2}
                value={p.description || ""}
                onChange={(e) => setP({ ...p, description: e.target.value })}
                placeholder="使用场景 / 维护负责人"
              />
            </Field>

            <div className="flex items-center justify-between rounded-md border bg-muted/30 px-3 py-2">
              <div className="space-y-0.5">
                <Label className="text-sm">禁用</Label>
                <p className="text-[11px] text-muted-foreground">
                  禁用后从新链中过滤,已使用此代理的旧链路依然能跑(并附带警告)。
                </p>
              </div>
              <Switch
                checked={!!p.disabled}
                onCheckedChange={(v) => setP({ ...p, disabled: v })}
              />
            </div>
          </div>
        </ScrollArea>

        <SheetFooter className="flex-row items-center justify-end gap-2 border-t bg-muted/30 px-6 py-3">
          <Button variant="outline" onClick={() => setOpen(false)} disabled={create.isPending}>
            取消
          </Button>
          <Button onClick={() => create.mutate()} disabled={!canCreate}>
            {create.isPending ? <Loader2 className="h-4 w-4 animate-spin" /> : <Plus className="h-4 w-4" />}
            创建
          </Button>
        </SheetFooter>
      </SheetContent>
    </Sheet>
  )
}

function Field({
  label,
  required,
  className,
  children,
}: {
  label: string
  required?: boolean
  className?: string
  children: React.ReactNode
}) {
  return (
    <div className={cn("space-y-1.5", className)}>
      <Label className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
        {label}
        {required && <span className="ml-0.5 text-destructive">*</span>}
      </Label>
      {children}
    </div>
  )
}

function initialDraft(): Partial<Proxy> & { credential_id?: number } {
  return { kind: "socks5", name: "", host: "", port: 1080, description: "", tags: "", disabled: false }
}
