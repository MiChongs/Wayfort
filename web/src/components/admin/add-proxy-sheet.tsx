"use client"

// AddProxySheet — Phase 10 Sheet-based replacement for the legacy CreateProxy
// Dialog. Renders a smart, per-kind form: the field set adapts to the proxy
// kind (direct hides host/port, bastion requires credential, etc.) and uses
// the same shadcn primitives as the rest of the admin surface.

import * as React from "react"
import { useMutation } from "@tanstack/react-query"
import { Loader2, Network, Plus, Tag } from "lucide-react"
import { toast } from "@/components/ui/sonner"
import { cn } from "@/lib/utils"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { ScrollArea } from "@/components/ui/scroll-area"
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
import { CredentialPicker } from "@/components/admin/credential-picker"
import { ProxyHeadersEditor } from "@/components/admin/proxy-headers-editor"
import { FailoverGroupEditor } from "@/components/admin/failover-group-editor"
import { proxyService } from "@/lib/api/services"
import type { Proxy, ProxyFailoverGroup, ProxyKind } from "@/lib/api/types"

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
    kind: "socks4",
    label: "SOCKS4",
    port: 1080,
    description: "SOCKS4/4a 出口。仅用户名 ident，无密码;可让代理端解析域名(4a)。",
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
    description: "HTTP/1.1 CONNECT 代理。支持 TLS-to-proxy、认证、自定义请求头。",
    needs: { host: true, port: true, credential: false },
  },
  {
    kind: "failover",
    label: "故障转移组",
    port: 0,
    description: "把多个代理聚成一跳,按策略自动切换 + 重试退避。在链中算作单个节点。",
    needs: { host: false, port: false, credential: false },
  },
]

const DEFAULT_GROUP: ProxyFailoverGroup = { members: [], strategy: "ordered", retry: 0, backoff_ms: 200 }

export interface AddProxySheetProps {
  credentials: { id: number; name: string }[]
  /** Catalog used by the failover group member picker. */
  proxies?: Proxy[]
  onCreated: () => void
}

export function AddProxySheet({ onCreated, proxies = [] }: AddProxySheetProps) {
  // `credentials` is still accepted for API compatibility but the embedded
  // CredentialPicker now fetches + caches the list itself.
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
    (p.kind !== "failover" || (p.group?.members?.length ?? 0) > 0) &&
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
                    onClick={() =>
                      setP({
                        ...p,
                        kind: opt.kind,
                        port: opt.port,
                        group: opt.kind === "failover" ? p.group ?? DEFAULT_GROUP : undefined,
                      })
                    }
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

            {p.kind !== "failover" && (
              <Field label={kindMeta.needs.credential ? "凭据 (必填)" : "凭据 (可选)"}>
                <CredentialPicker
                  value={p.credential_id ?? null}
                  onChange={(id) => setP({ ...p, credential_id: id ?? undefined })}
                  allowNone={!kindMeta.needs.credential}
                  placeholder={kindMeta.needs.credential ? "选择凭据" : "不绑定（可选）"}
                  aria-invalid={kindMeta.needs.credential && !p.credential_id}
                />
              </Field>
            )}

            {/* SOCKS4 — proxy-side name resolution toggle (4a). */}
            {p.kind === "socks4" && (
              <ToggleRow
                label="代理端解析域名 (SOCKS4a)"
                hint="开启后把目标域名交给代理解析,而非本地解析。"
                checked={!!p.socks4_remote}
                onCheckedChange={(v) => setP({ ...p, socks4_remote: v })}
              />
            )}

            {/* HTTP CONNECT — TLS-to-proxy, SNI, headers. */}
            {p.kind === "http_connect" && (
              <div className="space-y-3 rounded-md border border-border bg-accent/40 p-3">
                <ToggleRow
                  label="对代理使用 TLS (HTTPS CONNECT)"
                  hint="与代理本身建立 TLS,而非仅明文 CONNECT。"
                  checked={!!p.tls_to_proxy}
                  onCheckedChange={(v) => setP({ ...p, tls_to_proxy: v })}
                />
                {p.tls_to_proxy && (
                  <>
                    <Field label="TLS SNI (可选)">
                      <Input
                        value={p.proxy_sni || ""}
                        onChange={(e) => setP({ ...p, proxy_sni: e.target.value })}
                        placeholder="留空则用主机名"
                      />
                    </Field>
                    <ToggleRow
                      label="跳过证书校验"
                      hint="仅限实验环境;生产请保持关闭。"
                      checked={!!p.insecure_tls}
                      onCheckedChange={(v) => setP({ ...p, insecure_tls: v })}
                    />
                  </>
                )}
                <Field label="自定义请求头 (可选)">
                  <ProxyHeadersEditor
                    key={`hdr-${p.kind}`}
                    value={p.headers}
                    onChange={(h) => setP({ ...p, headers: h })}
                  />
                </Field>
              </div>
            )}

            {/* Failover group editor. */}
            {p.kind === "failover" && (
              <Field label="故障转移组">
                <FailoverGroupEditor
                  value={p.group ?? DEFAULT_GROUP}
                  onChange={(g) => setP({ ...p, group: g })}
                  proxies={proxies}
                />
              </Field>
            )}

            {/* Per-hop dial timeout for endpoint kinds. */}
            {kindMeta.needs.host && (
              <Field label="逐跳超时 (ms, 0=默认)">
                <Input
                  type="number"
                  min={0}
                  step={1000}
                  value={p.timeout_ms ?? 0}
                  onChange={(e) => setP({ ...p, timeout_ms: Math.max(0, Number(e.target.value)) })}
                  placeholder="0"
                />
              </Field>
            )}

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

function ToggleRow({
  label,
  hint,
  checked,
  onCheckedChange,
}: {
  label: string
  hint?: string
  checked: boolean
  onCheckedChange: (v: boolean) => void
}) {
  return (
    <div className="flex items-center justify-between gap-3 rounded-md border border-border bg-background px-3 py-2">
      <div className="space-y-0.5">
        <Label className="text-sm">{label}</Label>
        {hint && <p className="text-[11px] text-muted-foreground">{hint}</p>}
      </div>
      <Switch checked={checked} onCheckedChange={onCheckedChange} />
    </div>
  )
}

function initialDraft(): Partial<Proxy> & { credential_id?: number } {
  return { kind: "socks5", name: "", host: "", port: 1080, description: "", tags: "", disabled: false }
}
