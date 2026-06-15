"use client"

import * as React from "react"
import { useMutation } from "@tanstack/react-query"
import { Loader2, Network } from "lucide-react"
import { toast } from "@/components/ui/sonner"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { Textarea } from "@/components/ui/textarea"
import {
  Select, SelectContent, SelectItem, SelectTrigger, SelectValue,
} from "@/components/ui/select"
import {
  Sheet, SheetContent, SheetFooter, SheetHeader, SheetTitle, SheetTrigger,
} from "@/components/ui/sheet"
import { ScrollArea } from "@/components/ui/scroll-area"
import { domainService } from "@/lib/api/services"
import type { Domain, DomainKind } from "@/lib/api/types"

const KIND_OPTIONS: { value: DomainKind; label: string; hint: string }[] = [
  { value: "direct", label: "直连域", hint: "网关直接拨号目标，无代理" },
  { value: "proxy", label: "代理域", hint: "网关经代理链到达，链末端可为故障转移组" },
  { value: "agent", label: "Agent 域", hint: "内网反连 Agent 代为拨号，目标网络只需放行一条出站连接" },
]

interface DomainFormSheetProps {
  mode?: "create" | "edit"
  domain?: Domain
  trigger?: React.ReactNode
  open?: boolean
  onOpenChange?: (open: boolean) => void
  onSaved?: () => void
}

export function DomainFormSheet({
  mode = "create",
  domain,
  trigger,
  open: controlledOpen,
  onOpenChange,
  onSaved,
}: DomainFormSheetProps) {
  const isControlled = controlledOpen !== undefined
  const [internalOpen, setInternalOpen] = React.useState(false)
  const open = isControlled ? controlledOpen : internalOpen
  const setOpen = React.useCallback(
    (v: boolean) => (isControlled ? onOpenChange?.(v) : setInternalOpen(v)),
    [isControlled, onOpenChange],
  )

  const [name, setName] = React.useState("")
  const [kind, setKind] = React.useState<DomainKind>("direct")
  const [description, setDescription] = React.useState("")
  const [proxyChain, setProxyChain] = React.useState("")
  const [allowedProtocols, setAllowedProtocols] = React.useState("")
  const [maxConcurrent, setMaxConcurrent] = React.useState("0")

  // Seed the form whenever it opens (create → blank; edit → the row).
  React.useEffect(() => {
    if (!open) return
    setName(domain?.name ?? "")
    setKind(domain?.kind ?? "direct")
    setDescription(domain?.description ?? "")
    setProxyChain(domain?.proxy_chain ?? "")
    setAllowedProtocols(domain?.allowed_protocols ?? "")
    setMaxConcurrent(String(domain?.max_concurrent_sessions ?? 0))
  }, [open, domain])

  const isDefault = !!domain?.is_default

  const save = useMutation({
    mutationFn: async () => {
      const body: Partial<Domain> = {
        name: name.trim(),
        kind,
        description: description.trim(),
        // The backend rejects a chain on non-proxy domains, so only send it for proxy.
        proxy_chain: kind === "proxy" ? proxyChain.trim() : "",
        allowed_protocols: allowedProtocols.trim(),
        max_concurrent_sessions: Math.max(0, Number(maxConcurrent) || 0),
      }
      if (mode === "edit" && domain) {
        await domainService.update(domain.id, body)
      } else {
        await domainService.create(body)
      }
    },
    onSuccess: () => {
      toast.success(mode === "edit" ? "网域已更新" : "网域已创建")
      setOpen(false)
      onSaved?.()
    },
    onError: (e: Error) =>
      toast.error(mode === "edit" ? "更新失败" : "创建失败", { description: e.message }),
  })

  function submit() {
    if (!name.trim()) {
      toast.error("请填写网域名称")
      return
    }
    if (kind === "proxy" && !proxyChain.trim()) {
      toast.error("代理域必须配置代理链")
      return
    }
    save.mutate()
  }

  return (
    <Sheet open={open} onOpenChange={setOpen}>
      {trigger && <SheetTrigger asChild>{trigger}</SheetTrigger>}
      <SheetContent side="right" className="flex w-full flex-col gap-0 p-0 sm:max-w-lg">
        <SheetHeader className="border-b px-6 pb-4 pt-6">
          <SheetTitle className="flex items-center gap-2 text-base">
            <Network className="h-4 w-4 text-primary" />
            {mode === "edit" ? "编辑网域" : "新增网域"}
          </SheetTitle>
        </SheetHeader>

        <ScrollArea className="min-h-0 flex-1 px-6 py-4">
          <div className="space-y-5">
            <div className="space-y-2">
              <Label htmlFor="domain-name">名称</Label>
              <Input
                id="domain-name"
                value={name}
                onChange={(e) => setName(e.target.value)}
                placeholder="如：生产内网 / 客户A环境"
                autoFocus
              />
            </div>

            <div className="space-y-2">
              <Label>连通性类型</Label>
              <Select
                value={kind}
                onValueChange={(v) => setKind(v as DomainKind)}
                disabled={isDefault}
              >
                <SelectTrigger>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {KIND_OPTIONS.map((o) => (
                    <SelectItem key={o.value} value={o.value}>
                      {o.label}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
              <p className="text-xs text-muted-foreground">
                {KIND_OPTIONS.find((o) => o.value === kind)?.hint}
              </p>
              {isDefault && (
                <p className="text-xs text-muted-foreground">
                  默认网域类型已锁定为直连，不可更改。
                </p>
              )}
            </div>

            {kind === "proxy" && (
              <div className="space-y-2">
                <Label htmlFor="domain-chain">代理链</Label>
                <Input
                  id="domain-chain"
                  value={proxyChain}
                  onChange={(e) => setProxyChain(e.target.value)}
                  placeholder="代理 ID 逗号分隔，如 3,1（外层在前）"
                  className="font-mono"
                />
                <p className="text-xs text-muted-foreground">
                  有序代理 ID 列表，外层在前；可指向故障转移组。格式同节点旧版 proxy_chain。
                </p>
              </div>
            )}

            <div className="space-y-2">
              <Label htmlFor="domain-protocols">允许协议</Label>
              <Input
                id="domain-protocols"
                value={allowedProtocols}
                onChange={(e) => setAllowedProtocols(e.target.value)}
                placeholder="逗号分隔，如 ssh,rdp，留空=全部允许"
              />
              <p className="text-xs text-muted-foreground">
                白名单，空=全部。Agent 域建议禁用明文协议（telnet / 非 TLS 数据库）。
              </p>
            </div>

            <div className="space-y-2">
              <Label htmlFor="domain-max">并发会话上限</Label>
              <Input
                id="domain-max"
                type="number"
                min={0}
                value={maxConcurrent}
                onChange={(e) => setMaxConcurrent(e.target.value)}
              />
              <p className="text-xs text-muted-foreground">0 = 不限。</p>
            </div>

            <div className="space-y-2">
              <Label htmlFor="domain-desc">描述</Label>
              <Textarea
                id="domain-desc"
                value={description}
                onChange={(e) => setDescription(e.target.value)}
                placeholder="可选：说明这个网域覆盖哪些资产、归谁负责。"
                rows={3}
              />
            </div>
          </div>
        </ScrollArea>

        <SheetFooter className="flex-row justify-end gap-2 border-t px-6 py-4">
          <Button variant="outline" onClick={() => setOpen(false)} disabled={save.isPending}>
            取消
          </Button>
          <Button onClick={submit} disabled={save.isPending}>
            {save.isPending && <Loader2 className="h-4 w-4 animate-spin" />}
            {mode === "edit" ? "保存" : "创建"}
          </Button>
        </SheetFooter>
      </SheetContent>
    </Sheet>
  )
}
