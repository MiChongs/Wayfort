"use client"

// AddNodeSheet — a right-edge Sheet hosting a humanized, visual node-creation
// form: 基础 (visual protocol picker + icon) → 认证 → 代理链 → 高级 (协议参数 +
// 策略). Every backend Node field is wired (icon / disabled / approval flags /
// proto_options), so the frontend口径 matches the model 1:1.

import * as React from "react"
import { useMutation } from "@tanstack/react-query"
import {
  ChevronDown,
  KeyRound,
  Layers,
  Loader2,
  Network,
  Plus,
  Power,
  Server,
  ShieldCheck,
  Sliders,
} from "lucide-react"
import { toast } from "@/components/ui/sonner"
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
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs"
import { Textarea } from "@/components/ui/textarea"
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from "@/components/ui/tooltip"
import { ProxyChainBuilder } from "@/components/admin/proxy-chain-builder"
import { RdpOptionsForm } from "@/components/admin/nodes/rdp-options-form"
import { OssOptionsForm } from "@/components/admin/nodes/oss-options-form"
import { AppIcon } from "@/components/icons/app-icon"
import { IconPicker } from "@/components/icons/icon-picker"
import { protocolIconToken } from "@/lib/icons"
import { nodeService } from "@/lib/api/services"
import type { Node, NodeProtocol, Proxy } from "@/lib/api/types"

export interface AddNodeSheetProps {
  credentials: { id: number; name: string }[]
  proxies: Proxy[]
  onCreated: () => void
}

type ProtoMeta = { id: NodeProtocol; label: string; port: number; hint?: string }

// Common protocols shown as visual cards.
const PRIMARY_PROTOCOLS: ProtoMeta[] = [
  { id: "ssh", label: "SSH", port: 22, hint: "终端 / SFTP" },
  { id: "telnet", label: "Telnet", port: 23, hint: "传统终端" },
  { id: "rdp", label: "RDP", port: 3389, hint: "Windows 桌面" },
  { id: "vnc", label: "VNC", port: 5900, hint: "图形桌面" },
  { id: "mysql", label: "MySQL", port: 3306, hint: "数据库" },
  { id: "postgres", label: "PostgreSQL", port: 5432, hint: "数据库" },
  { id: "redis", label: "Redis", port: 6379, hint: "缓存" },
  { id: "mongo", label: "MongoDB", port: 27017, hint: "文档库" },
  { id: "tcp", label: "TCP", port: 0, hint: "端口转发" },
  { id: "oss", label: "对象存储", port: 443, hint: "OSS / COS / S3" },
]

// 国产 / 兼容数据库 — folded into a select to keep the grid tidy.
const MORE_DB_PROTOCOLS: ProtoMeta[] = [
  { id: "dameng", label: "达梦 DM8", port: 5236 },
  { id: "kingbase", label: "人大金仓 Kingbase", port: 54321 },
  { id: "vastbase", label: "海量 Vastbase", port: 5432 },
  { id: "highgo", label: "瀚高 HighgoDB", port: 5866 },
  { id: "opengauss", label: "华为 openGauss", port: 5432 },
  { id: "gaussdb", label: "华为 GaussDB", port: 8000 },
  { id: "tidb", label: "PingCAP TiDB", port: 4000 },
  { id: "oceanbase", label: "OceanBase", port: 2881 },
  { id: "starrocks", label: "StarRocks", port: 9030 },
  { id: "doris", label: "Apache Doris", port: 9030 },
  { id: "gbase8a", label: "GBase 8a", port: 5258 },
  { id: "gbase8s", label: "GBase 8s", port: 9088 },
]

const ALL_PROTOCOLS = [...PRIMARY_PROTOCOLS, ...MORE_DB_PROTOCOLS]

type Draft = Partial<Node> & { credential_id?: number }

const INITIAL_DRAFT: Draft = {
  protocol: "ssh",
  port: 22,
  name: "",
  host: "",
  username: "",
  proxy_chain: "",
  icon: "",
  disabled: false,
  requires_approval_for_connect: false,
  requires_approval_for_file_xfer: false,
}

export function AddNodeSheet({ credentials, proxies, onCreated }: AddNodeSheetProps) {
  const [open, setOpen] = React.useState(false)
  const [tab, setTab] = React.useState("basic")
  const [draft, setDraft] = React.useState<Draft>(INITIAL_DRAFT)

  React.useEffect(() => {
    if (open) {
      setDraft(INITIAL_DRAFT)
      setTab("basic")
    }
  }, [open])

  const patch = React.useCallback((p: Partial<Draft>) => setDraft((d) => ({ ...d, ...p })), [])

  const pickProtocol = React.useCallback(
    (id: NodeProtocol) => {
      const meta = ALL_PROTOCOLS.find((p) => p.id === id)
      setDraft((d) => ({ ...d, protocol: id, port: meta ? meta.port : d.port, proto_options: "" }))
    },
    [],
  )

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
  const target = draft.host && draft.port ? `${draft.host}:${draft.port}` : undefined
  const effectiveIcon = draft.icon || protocolIconToken(draft.protocol)
  const hopCount = (draft.proxy_chain || "").split(",").filter(Boolean).length
  const moreDbValue = MORE_DB_PROTOCOLS.some((d) => d.id === draft.protocol) ? draft.protocol : ""

  return (
    <TooltipProvider delayDuration={150}>
      <Sheet open={open} onOpenChange={setOpen}>
        <SheetTrigger asChild>
          <Button>
            <Plus className="h-4 w-4" /> 新增节点
          </Button>
        </SheetTrigger>
        <SheetContent side="right" className="flex w-full flex-col gap-0 p-0 sm:max-w-[660px]">
          <SheetHeader className="border-b px-6 pt-6 pb-4">
            <SheetTitle className="flex items-center gap-2.5 text-base">
              <span className="flex h-8 w-8 items-center justify-center rounded-lg border bg-muted/40">
                <AppIcon icon={effectiveIcon} size={18} />
              </span>
              新增节点
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
                {/* 名称 + 图标 */}
                <div className="flex items-end gap-3">
                  <Field label="名称" required className="flex-1">
                    <Input
                      value={draft.name || ""}
                      onChange={(e) => patch({ name: e.target.value })}
                      placeholder="如:prod-web-01"
                    />
                  </Field>
                  <Field label="图标">
                    <IconPicker
                      value={draft.icon || ""}
                      onChange={(token) => patch({ icon: token })}
                      placeholder="默认"
                      trigger={
                        <button
                          type="button"
                          className="inline-flex h-9 items-center gap-2 rounded-md border border-border bg-background px-3 text-sm transition-colors hover:bg-accent/50"
                          title={draft.icon ? "自定义图标" : "默认(按协议)"}
                        >
                          <AppIcon icon={effectiveIcon} size={16} />
                          <ChevronDown className="h-3.5 w-3.5 opacity-50" />
                        </button>
                      }
                    />
                  </Field>
                </div>

                {/* 协议 — 可视化选择 */}
                <Field label="协议" required>
                  <div className="grid grid-cols-3 gap-2 sm:grid-cols-5">
                    {PRIMARY_PROTOCOLS.map((p) => (
                      <ProtocolCard
                        key={p.id}
                        meta={p}
                        active={draft.protocol === p.id}
                        onClick={() => pickProtocol(p.id)}
                      />
                    ))}
                  </div>
                  <div className="mt-2 flex items-center gap-2">
                    <span className="shrink-0 text-[11px] text-muted-foreground">更多数据库</span>
                    <Select value={moreDbValue} onValueChange={(v) => pickProtocol(v as NodeProtocol)}>
                      <SelectTrigger className="h-8 flex-1 text-xs">
                        <SelectValue placeholder="国产 / 兼容引擎 (达梦 / 金仓 / TiDB …)" />
                      </SelectTrigger>
                      <SelectContent>
                        {MORE_DB_PROTOCOLS.map((p) => (
                          <SelectItem key={p.id} value={p.id} className="text-xs">
                            <span className="flex items-center gap-2">
                              <AppIcon icon={protocolIconToken(p.id)} size={14} />
                              {p.label}
                            </span>
                          </SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                  </div>
                </Field>

                {/* 主机 + 端口 + 实时目标预览 */}
                <div className="grid grid-cols-3 gap-3">
                  <Field label="主机" className="col-span-2" required>
                    <Input
                      value={draft.host || ""}
                      onChange={(e) => patch({ host: e.target.value })}
                      placeholder="hostname 或 IP"
                    />
                  </Field>
                  <Field label="端口" required>
                    <Input
                      type="number"
                      value={draft.port || ""}
                      onChange={(e) => patch({ port: Number(e.target.value) })}
                    />
                  </Field>
                </div>
                {target && (
                  <div className="flex items-center gap-2 rounded-md border border-dashed bg-muted/30 px-2.5 py-1.5 text-[11px] text-muted-foreground">
                    <Server className="h-3.5 w-3.5 opacity-60" />
                    连接目标
                    <span className="font-mono text-foreground/80">{target}</span>
                  </div>
                )}

                <div className="grid grid-cols-2 gap-3">
                  <Field label="区域">
                    <Input
                      value={draft.region || ""}
                      onChange={(e) => patch({ region: e.target.value })}
                      placeholder="asia-east / us-west"
                    />
                  </Field>
                  <Field label="标签(逗号分隔)">
                    <Input
                      value={draft.tags || ""}
                      onChange={(e) => patch({ tags: e.target.value })}
                      placeholder="prod, db, app"
                    />
                  </Field>
                </div>

                <Field label="描述">
                  <Textarea
                    rows={3}
                    value={draft.description || ""}
                    onChange={(e) => patch({ description: e.target.value })}
                    placeholder="例:核心交易服务,只允许只读会话"
                  />
                </Field>
              </TabsContent>

              <TabsContent value="auth" className="mt-0 space-y-4">
                <div className="grid grid-cols-2 gap-3">
                  <Field label="登录用户名">
                    <Input
                      value={draft.username || ""}
                      onChange={(e) => patch({ username: e.target.value })}
                      placeholder="如:root / Administrator"
                    />
                  </Field>
                  <Field label="凭据" required>
                    <Select
                      value={draft.credential_id ? String(draft.credential_id) : ""}
                      onValueChange={(v) => patch({ credential_id: Number(v) })}
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
                  凭据库管理在 <span className="font-mono">/admin/credentials</span>。 新增凭据后,这里会自动出现在选择器中。
                </div>
              </TabsContent>

              <TabsContent value="chain" className="mt-0 space-y-3">
                <ProxyChainBuilder
                  value={draft.proxy_chain || ""}
                  onChange={(v) => patch({ proxy_chain: v })}
                  proxies={proxies}
                  target={target}
                />
              </TabsContent>

              <TabsContent value="advanced" className="mt-0 space-y-5">
                <Field label="协议参数">
                  {draft.protocol === "rdp" ? (
                    <RdpOptionsForm value={draft.proto_options} onChange={(v) => patch({ proto_options: v })} />
                  ) : draft.protocol === "oss" ? (
                    <OssOptionsForm
                      value={draft.proto_options || ""}
                      credentialId={draft.credential_id}
                      proxyChain={draft.proxy_chain}
                      onChange={(next) => patch(next)}
                    />
                  ) : (
                    <div className="space-y-1.5">
                      <Textarea
                        rows={4}
                        value={draft.proto_options || ""}
                        onChange={(e) => patch({ proto_options: e.target.value })}
                        placeholder='示例:{"database":"main"}'
                      />
                      <p className="text-[11px] text-muted-foreground">
                        其他协议沿用 JSON 文本;RDP / 对象存储会渲染结构化表单。
                      </p>
                    </div>
                  )}
                </Field>

                <div className="space-y-3 rounded-lg border bg-muted/20 p-3">
                  <h4 className="inline-flex items-center gap-1.5 text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">
                    <ShieldCheck className="h-3.5 w-3.5" /> 策略
                  </h4>
                  <PolicyToggle
                    icon={<Power className="h-4 w-4" />}
                    label="禁用此节点"
                    description="禁用后该节点在工作台不可连接,仅保留配置。"
                    checked={!!draft.disabled}
                    onChange={(v) => patch({ disabled: v })}
                    danger
                  />
                  <PolicyToggle
                    icon={<ShieldCheck className="h-4 w-4" />}
                    label="连接需审批"
                    description="发起连接前必须有生效的审批授权(asset_access)。"
                    checked={!!draft.requires_approval_for_connect}
                    onChange={(v) => patch({ requires_approval_for_connect: v })}
                  />
                  <PolicyToggle
                    icon={<ShieldCheck className="h-4 w-4" />}
                    label="文件传输需审批"
                    description="SFTP / 桌面盘上传下载前必须有生效的审批授权。"
                    checked={!!draft.requires_approval_for_file_xfer}
                    onChange={(v) => patch({ requires_approval_for_file_xfer: v })}
                  />
                </div>
              </TabsContent>
            </ScrollArea>

            <SheetFooter className="mt-0 flex-row items-center gap-2 border-t bg-muted/30 px-6 py-3">
              <ChecklistBadge label="基础" ok={!!draft.name && !!draft.host && !!draft.port} onClick={() => setTab("basic")} />
              <ChecklistBadge label="认证" ok={!!draft.credential_id} onClick={() => setTab("auth")} />
              <ChecklistBadge
                label="代理链"
                ok
                accent={hopCount > 0 ? "info" : "muted"}
                onClick={() => setTab("chain")}
                detail={hopCount === 0 ? "直连" : `${hopCount} 跳`}
              />
              <div className="ml-auto flex items-center gap-2">
                <Button variant="outline" onClick={() => setOpen(false)} disabled={create.isPending}>
                  取消
                </Button>
                <Tooltip>
                  <TooltipTrigger asChild>
                    <span>
                      <Button onClick={() => create.mutate()} disabled={!canCreate}>
                        {create.isPending ? <Loader2 className="h-4 w-4 animate-spin" /> : <Plus className="h-4 w-4" />}
                        创建节点
                      </Button>
                    </span>
                  </TooltipTrigger>
                  {!canCreate && !create.isPending && <TooltipContent>请补全名称、主机、端口与凭据</TooltipContent>}
                </Tooltip>
              </div>
            </SheetFooter>
          </Tabs>
        </SheetContent>
      </Sheet>
    </TooltipProvider>
  )
}

function ProtocolCard({ meta, active, onClick }: { meta: ProtoMeta; active: boolean; onClick: () => void }) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={cn(
        "flex flex-col items-center gap-1 rounded-lg border px-1.5 py-2 text-center transition-colors focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none",
        active
          ? "border-primary bg-primary/5 text-foreground ring-1 ring-primary/30"
          : "border-border/60 text-muted-foreground hover:bg-accent/50 hover:text-foreground",
      )}
      title={meta.hint}
    >
      <AppIcon icon={protocolIconToken(meta.id)} size={20} />
      <span className="text-[11px] font-medium leading-none">{meta.label}</span>
      <span className="text-[9px] leading-none opacity-60">{meta.port || "—"}</span>
    </button>
  )
}

function PolicyToggle({
  icon,
  label,
  description,
  checked,
  onChange,
  danger,
}: {
  icon: React.ReactNode
  label: string
  description: string
  checked: boolean
  onChange: (v: boolean) => void
  danger?: boolean
}) {
  return (
    <div className="flex items-start justify-between gap-3">
      <div className="flex min-w-0 gap-2">
        <span className={cn("mt-0.5 shrink-0", checked && danger ? "text-destructive" : checked ? "text-primary" : "text-muted-foreground")}>
          {icon}
        </span>
        <div className="space-y-0.5 min-w-0">
          <Label className="text-xs">{label}</Label>
          <p className="text-[11px] leading-snug text-muted-foreground">{description}</p>
        </div>
      </div>
      <Switch checked={checked} onCheckedChange={onChange} className="mt-0.5 shrink-0" />
    </div>
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
      {detail && (
        <Badge variant="outline" className="h-4 border-none bg-background/60 px-1 text-[10px]">
          {detail}
        </Badge>
      )}
    </button>
  )
}
