"use client"

// AddNodeSheet — Phase 10 replacement for the legacy CreateNodeDialog. A
// right-edge Sheet (shadcn) hosts a tabbed form that walks the operator
// through Basic → Authentication → Proxy Chain → Advanced, with the new
// ProxyChainBuilder embedded so the chain is composed visually rather than
// typed as a comma list.
//
// The Sheet stays the recommended container for long, multi-section forms in
// the shadcn idiom — it preserves page context, occupies a full vertical
// rail, and keeps the user oriented within the admin surface.

import * as React from "react"
import { useMutation } from "@tanstack/react-query"
import {
  KeyRound,
  Layers,
  Loader2,
  Network,
  Plus,
  Server,
  Sliders,
} from "lucide-react"
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
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs"
import { Textarea } from "@/components/ui/textarea"
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from "@/components/ui/tooltip"
import { ProxyChainBuilder } from "@/components/admin/proxy-chain-builder"
import { RdpOptionsForm } from "@/components/admin/nodes/rdp-options-form"
import { nodeService } from "@/lib/api/services"
import type { Node, NodeProtocol, Proxy } from "@/lib/api/types"

export interface AddNodeSheetProps {
  credentials: { id: number; name: string }[]
  proxies: Proxy[]
  onCreated: () => void
}

const PROTO_OPTIONS: { id: NodeProtocol; label: string; port: number; hint?: string }[] = [
  { id: "ssh", label: "SSH", port: 22, hint: "终端 / SFTP" },
  { id: "telnet", label: "Telnet", port: 23, hint: "传统终端" },
  { id: "rdp", label: "RDP", port: 3389, hint: "Windows 远程桌面" },
  { id: "vnc", label: "VNC", port: 5900, hint: "Linux/Mac 桌面" },
  { id: "mysql", label: "MySQL", port: 3306, hint: "数据库 CLI" },
  { id: "postgres", label: "PostgreSQL", port: 5432, hint: "数据库 CLI" },
  { id: "redis", label: "Redis", port: 6379, hint: "缓存 CLI" },
  { id: "mongo", label: "MongoDB", port: 27017, hint: "文档 CLI" },
  { id: "tcp", label: "TCP 端口转发", port: 0, hint: "纯 TCP 流量" },
]

export function AddNodeSheet({ credentials, proxies, onCreated }: AddNodeSheetProps) {
  const [open, setOpen] = React.useState(false)
  const [tab, setTab] = React.useState("basic")
  const [draft, setDraft] = React.useState<Partial<Node> & { credential_id?: number }>({
    protocol: "ssh",
    port: 22,
    name: "",
    host: "",
    username: "",
    proxy_chain: "",
  })

  // Reset draft each time the Sheet opens — prevents stale data leaking across
  // accidental re-opens after a previous successful create.
  React.useEffect(() => {
    if (open) {
      setDraft({ protocol: "ssh", port: 22, name: "", host: "", username: "", proxy_chain: "" })
      setTab("basic")
    }
  }, [open])

  const create = useMutation({
    mutationFn: () => nodeService.create(draft as Node),
    onSuccess: () => {
      toast.success("节点已创建", { description: draft.name })
      setOpen(false)
      onCreated()
    },
    onError: (e: Error) => toast.error("创建失败", { description: e.message }),
  })

  const canCreate = !!draft.name && !!draft.host && !!draft.credential_id && !create.isPending
  const target =
    draft.host && draft.port ? `${draft.host}:${draft.port}` : undefined

  return (
    <TooltipProvider delayDuration={150}>
      <Sheet open={open} onOpenChange={setOpen}>
        <SheetTrigger asChild>
          <Button>
            <Plus className="h-4 w-4" /> 新增节点
          </Button>
        </SheetTrigger>
        <SheetContent
          side="right"
          className="flex w-full flex-col gap-0 p-0 sm:max-w-[640px]"
        >
          <SheetHeader className="border-b px-6 pt-6 pb-4">
            <SheetTitle className="flex items-center gap-2 text-base">
              <Server className="h-4 w-4" /> 新增节点
            </SheetTitle>
            <SheetDescription>
              录入资产基础信息、认证凭据与代理链。所有字段都可在节点详情中再次编辑。
            </SheetDescription>
          </SheetHeader>

          <Tabs value={tab} onValueChange={setTab} className="flex min-h-0 flex-1 flex-col">
            <TabsList className="mx-6 mt-4 grid w-auto grid-cols-4 self-start">
              <TabsTrigger value="basic" className="gap-1.5">
                <Server className="h-3.5 w-3.5" /> 基础
              </TabsTrigger>
              <TabsTrigger value="auth" className="gap-1.5">
                <KeyRound className="h-3.5 w-3.5" /> 认证
              </TabsTrigger>
              <TabsTrigger value="chain" className="gap-1.5">
                <Network className="h-3.5 w-3.5" /> 代理链
              </TabsTrigger>
              <TabsTrigger value="advanced" className="gap-1.5">
                <Sliders className="h-3.5 w-3.5" /> 高级
              </TabsTrigger>
            </TabsList>

            <ScrollArea className="flex-1 px-6 pt-4 pb-2">
              <TabsContent value="basic" className="mt-0 space-y-4">
                <div className="grid grid-cols-2 gap-3">
                  <Field label="名称" required>
                    <Input
                      value={draft.name || ""}
                      onChange={(e) => setDraft({ ...draft, name: e.target.value })}
                      placeholder="如:prod-web-01"
                    />
                  </Field>
                  <Field label="协议" required>
                    <Select
                      value={draft.protocol}
                      onValueChange={(v) =>
                        setDraft({
                          ...draft,
                          protocol: v as NodeProtocol,
                          port: defaultPortFor(v as NodeProtocol),
                        })
                      }
                    >
                      <SelectTrigger>
                        <SelectValue />
                      </SelectTrigger>
                      <SelectContent>
                        {PROTO_OPTIONS.map((p) => (
                          <SelectItem key={p.id} value={p.id}>
                            <div className="flex items-center gap-2">
                              <span className="font-medium">{p.label}</span>
                              {p.hint && <span className="text-xs text-muted-foreground">· {p.hint}</span>}
                            </div>
                          </SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                  </Field>
                </div>

                <div className="grid grid-cols-3 gap-3">
                  <Field label="主机" className="col-span-2" required>
                    <Input
                      value={draft.host || ""}
                      onChange={(e) => setDraft({ ...draft, host: e.target.value })}
                      placeholder="hostname 或 IP"
                    />
                  </Field>
                  <Field label="端口" required>
                    <Input
                      type="number"
                      value={draft.port || ""}
                      onChange={(e) => setDraft({ ...draft, port: Number(e.target.value) })}
                    />
                  </Field>
                </div>

                <div className="grid grid-cols-2 gap-3">
                  <Field label="区域">
                    <Input
                      value={draft.region || ""}
                      onChange={(e) => setDraft({ ...draft, region: e.target.value })}
                      placeholder="asia-east / us-west"
                    />
                  </Field>
                  <Field label="标签(逗号分隔)">
                    <Input
                      value={draft.tags || ""}
                      onChange={(e) => setDraft({ ...draft, tags: e.target.value })}
                      placeholder="prod, db, app"
                    />
                  </Field>
                </div>

                <Field label="描述">
                  <Textarea
                    rows={3}
                    value={draft.description || ""}
                    onChange={(e) => setDraft({ ...draft, description: e.target.value })}
                    placeholder="例:核心交易服务,只允许只读会话"
                  />
                </Field>
              </TabsContent>

              <TabsContent value="auth" className="mt-0 space-y-4">
                <div className="grid grid-cols-2 gap-3">
                  <Field label="登录用户名">
                    <Input
                      value={draft.username || ""}
                      onChange={(e) => setDraft({ ...draft, username: e.target.value })}
                      placeholder="如:root / Administrator"
                    />
                  </Field>
                  <Field label="凭据" required>
                    <Select
                      value={draft.credential_id ? String(draft.credential_id) : ""}
                      onValueChange={(v) =>
                        setDraft({ ...draft, credential_id: Number(v) })
                      }
                    >
                      <SelectTrigger>
                        <SelectValue placeholder="选择凭据" />
                      </SelectTrigger>
                      <SelectContent>
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
                </div>
                <div className="rounded-md border bg-muted/30 p-3 text-xs text-muted-foreground">
                  凭据库管理在 <span className="font-mono">/admin/credentials</span>。
                  新增凭据后,这里会自动出现在选择器中。
                </div>
              </TabsContent>

              <TabsContent value="chain" className="mt-0 space-y-3">
                <ProxyChainBuilder
                  value={draft.proxy_chain || ""}
                  onChange={(v) => setDraft({ ...draft, proxy_chain: v })}
                  proxies={proxies}
                  target={target}
                />
              </TabsContent>

              <TabsContent value="advanced" className="mt-0 space-y-4">
                <Field label="协议参数">
                  {draft.protocol === "rdp" ? (
                    <RdpOptionsForm
                      value={draft.proto_options}
                      onChange={(v) => setDraft({ ...draft, proto_options: v })}
                    />
                  ) : (
                    <div className="space-y-1.5">
                      <Textarea
                        rows={4}
                        value={draft.proto_options || ""}
                        onChange={(e) => setDraft({ ...draft, proto_options: e.target.value })}
                        placeholder='示例:{"database":"main"}'
                      />
                      <p className="text-[11px] text-muted-foreground">
                        其他协议沿用 JSON 文本;RDP 协议会渲染结构化表单。
                      </p>
                    </div>
                  )}
                </Field>
              </TabsContent>
            </ScrollArea>

            <SheetFooter className="mt-0 flex-row items-center gap-2 border-t bg-muted/30 px-6 py-3">
              <ChecklistBadge
                label="基础"
                ok={!!draft.name && !!draft.host && !!draft.port}
                onClick={() => setTab("basic")}
              />
              <ChecklistBadge
                label="认证"
                ok={!!draft.credential_id}
                onClick={() => setTab("auth")}
              />
              <ChecklistBadge
                label="代理链"
                ok
                accent={(draft.proxy_chain || "").split(",").filter(Boolean).length > 0 ? "info" : "muted"}
                onClick={() => setTab("chain")}
                detail={
                  (draft.proxy_chain || "").split(",").filter(Boolean).length === 0
                    ? "直连"
                    : `${(draft.proxy_chain || "").split(",").filter(Boolean).length} 跳`
                }
              />
              <div className="ml-auto flex items-center gap-2">
                <Button variant="outline" onClick={() => setOpen(false)} disabled={create.isPending}>
                  取消
                </Button>
                <Tooltip>
                  <TooltipTrigger asChild>
                    <span>
                      <Button onClick={() => create.mutate()} disabled={!canCreate}>
                        {create.isPending ? (
                          <Loader2 className="h-4 w-4 animate-spin" />
                        ) : (
                          <Plus className="h-4 w-4" />
                        )}
                        创建节点
                      </Button>
                    </span>
                  </TooltipTrigger>
                  {!canCreate && !create.isPending && (
                    <TooltipContent>请补全名称、主机、端口与凭据</TooltipContent>
                  )}
                </Tooltip>
              </div>
            </SheetFooter>
          </Tabs>
        </SheetContent>
      </Sheet>
    </TooltipProvider>
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

function ChecklistBadge({
  label,
  ok,
  detail,
  accent = "muted",
  onClick,
}: {
  label: string
  ok: boolean
  detail?: string
  accent?: "muted" | "info"
  onClick?: () => void
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={cn(
        "inline-flex items-center gap-1.5 rounded-full border px-2 py-0.5 text-[11px] transition-colors hover:bg-muted/70 focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none",
        ok
          ? accent === "info"
            ? "border-sky-500/30 bg-sky-500/10 text-sky-600 dark:text-sky-300"
            : "border-emerald-500/30 bg-emerald-500/10 text-emerald-600 dark:text-emerald-300"
          : "border-amber-500/30 bg-amber-500/10 text-amber-700 dark:text-amber-300",
      )}
    >
      <Layers className="h-3 w-3" />
      <span>{label}</span>
      {detail && <Badge variant="outline" className="h-4 border-none bg-background/60 px-1 text-[10px]">{detail}</Badge>}
    </button>
  )
}

function defaultPortFor(p: NodeProtocol): number {
  return PROTO_OPTIONS.find((o) => o.id === p)?.port ?? 0
}
