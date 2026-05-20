"use client"

import * as React from "react"
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query"
import {
  ArrowDown,
  ArrowUp,
  ChevronDown,
  Plus,
  Server,
  Trash2,
  X,
} from "lucide-react"
import { toast } from "sonner"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { Textarea } from "@/components/ui/textarea"
import { Badge } from "@/components/ui/badge"
import { Separator } from "@/components/ui/separator"
import {
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectLabel,
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
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from "@/components/ui/collapsible"
import { credentialService, nodeService, proxyService } from "@/lib/api/services"
import type { Node, NodeProtocol, Proxy } from "@/lib/api/types"
import { DataTable, type Column } from "@/components/common/data-table"
import { RdpOptionsForm } from "@/components/admin/nodes/rdp-options-form"
import { cn } from "@/lib/utils"

export default function AdminNodesPage() {
  const qc = useQueryClient()
  const nodes = useQuery({ queryKey: ["admin", "nodes"], queryFn: nodeService.list })
  const creds = useQuery({ queryKey: ["admin", "credentials"], queryFn: credentialService.list })
  const proxies = useQuery({ queryKey: ["admin", "proxies"], queryFn: proxyService.list })

  const remove = useMutation({
    mutationFn: (id: number) => nodeService.remove(id),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["admin", "nodes"] }),
  })

  const columns: Column<Node>[] = [
    { header: "名称", cell: (n) => <span className="font-medium">{n.name}</span> },
    { header: "协议", cell: (n) => <Badge variant="secondary">{n.protocol}</Badge> },
    { header: "地址", cell: (n) => `${n.host}:${n.port}` },
    { header: "用户", cell: (n) => n.username || "—" },
    { header: "代理链", cell: (n) => n.proxy_chain || "直连" },
    {
      header: "操作",
      className: "text-right",
      cell: (n) => (
        <Button
          variant="ghost"
          size="icon"
          onClick={() => confirm("确认删除？") && remove.mutate(n.id)}
        >
          <Trash2 className="w-4 h-4 text-destructive" />
        </Button>
      ),
    },
  ]

  return (
    <div className="p-6 space-y-4">
      <div className="flex items-center justify-between">
        <h1 className="text-2xl font-semibold tracking-tight flex items-center gap-2">
          <Server className="w-5 h-5" /> 节点
        </h1>
        <CreateNodeSheet
          credentials={creds.data?.credentials || []}
          proxies={proxies.data?.proxies || []}
          onCreated={() => qc.invalidateQueries({ queryKey: ["admin", "nodes"] })}
        />
      </div>
      <DataTable columns={columns} rows={nodes.data?.nodes} loading={nodes.isLoading} />
    </div>
  )
}

// ----------------------------------------------------------------------------
// CreateNodeSheet — Sheet-based form. Replaces the dialog so the form has
// room to breathe (sticky header / footer, collapsible advanced sections,
// chip-based proxy chain editor, smart host paste).
// ----------------------------------------------------------------------------

const PROTOCOL_GROUPS: { label: string; items: { value: NodeProtocol; hint?: string }[] }[] = [
  {
    label: "字符",
    items: [
      { value: "ssh" },
      { value: "telnet" },
    ],
  },
  {
    label: "图形",
    items: [
      { value: "rdp" },
      { value: "vnc" },
    ],
  },
  {
    label: "数据库",
    items: [
      { value: "mysql" },
      { value: "postgres" },
      { value: "redis" },
      { value: "mongo" },
    ],
  },
  {
    label: "通用",
    items: [
      { value: "tcp", hint: "任意 TCP 端口转发" },
    ],
  },
]

function CreateNodeSheet({
  credentials,
  proxies,
  onCreated,
}: {
  credentials: { id: number; name: string }[]
  proxies: Proxy[]
  onCreated: () => void
}) {
  const [open, setOpen] = React.useState(false)
  const [draft, setDraft] = React.useState<Partial<Node> & { credential_id?: number }>(initialDraft())
  // Remember the last port that was set by protocol-switch auto-fill so we
  // only overwrite when the user hasn't typed their own value. Avoids
  // surprising the operator who set port=2222 then flipped between protocols.
  const lastAutoPortRef = React.useRef<number | undefined>(22)

  const reset = () => {
    setDraft(initialDraft())
    lastAutoPortRef.current = 22
  }

  const create = useMutation({
    mutationFn: () => nodeService.create(draft as Node),
    onSuccess: () => {
      setOpen(false)
      reset()
      onCreated()
      toast.success("已创建节点")
    },
    onError: (e: unknown) => toast.error("创建失败", { description: (e as Error).message }),
  })

  // Host paste handler: accepts "host", "host:port", "user@host", or
  // "user@host:port". Fills whichever fields are derivable in one step
  // so operators copying from `ssh user@host -p 2222` don't have to
  // split it manually.
  const onHostPaste = (raw: string) => {
    let value = raw.trim()
    let user = ""
    if (value.includes("@")) {
      const [u, rest] = value.split("@", 2)
      user = u
      value = rest
    }
    let port: number | undefined
    if (value.includes(":")) {
      const [h, p] = value.split(":", 2)
      const n = Number(p)
      if (Number.isFinite(n) && n > 0) {
        port = n
        value = h
      }
    }
    setDraft((d) => ({
      ...d,
      host: value,
      username: d.username || user,
      port: port ?? d.port,
      name: d.name || value,
    }))
    if (port !== undefined) lastAutoPortRef.current = port
  }

  const onProtocolChange = (next: NodeProtocol) => {
    const defaultPortNext = defaultPort(next)
    setDraft((d) => {
      // Only overwrite the port if it's still the previous protocol's
      // auto-default (i.e. the operator hasn't customised it).
      const keep = d.port !== lastAutoPortRef.current
      lastAutoPortRef.current = defaultPortNext
      return { ...d, protocol: next, port: keep ? d.port : defaultPortNext }
    })
  }

  // proxy_chain is a comma-separated string. Editor uses chips so the
  // operator picks from available proxies without memorising IDs.
  const chainIDs = parseChain(draft.proxy_chain)
  const setChain = (next: number[]) =>
    setDraft((d) => ({ ...d, proxy_chain: next.join(",") }))

  const canSubmit = Boolean(draft.name && draft.host && draft.credential_id)

  return (
    <Sheet
      open={open}
      onOpenChange={(o) => {
        setOpen(o)
        if (!o) reset()
      }}
    >
      <SheetTrigger asChild>
        <Button>
          <Plus className="w-4 h-4" /> 新增节点
        </Button>
      </SheetTrigger>
      <SheetContent
        side="right"
        className="!w-full sm:!max-w-2xl flex flex-col p-0 gap-0"
      >
        <SheetHeader className="border-b px-6 py-4 shrink-0">
          <SheetTitle>新增节点</SheetTitle>
          <SheetDescription>
            填好主机与凭据即可保存。代理链、标签、协议参数全部可选；保存后随时编辑。
          </SheetDescription>
        </SheetHeader>

        <div className="flex-1 overflow-y-auto px-6 py-5 space-y-6">
          {/* 基础 */}
          <section className="space-y-4">
            <FieldGrid>
              <Field label="名称" required>
                <Input
                  value={draft.name || ""}
                  onChange={(e) => setDraft({ ...draft, name: e.target.value })}
                  placeholder="留空将自动用主机名"
                />
              </Field>
              <Field label="协议" required>
                <Select value={draft.protocol} onValueChange={(v) => onProtocolChange(v as NodeProtocol)}>
                  <SelectTrigger>
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {PROTOCOL_GROUPS.map((g) => (
                      <SelectGroup key={g.label}>
                        <SelectLabel>{g.label}</SelectLabel>
                        {g.items.map((it) => (
                          <SelectItem key={it.value} value={it.value}>
                            <span className="font-mono">{it.value}</span>
                            {it.hint && (
                              <span className="ml-2 text-xs text-muted-foreground">{it.hint}</span>
                            )}
                          </SelectItem>
                        ))}
                      </SelectGroup>
                    ))}
                  </SelectContent>
                </Select>
              </Field>
            </FieldGrid>

            <FieldGrid cols={[2, 1]}>
              <Field label="主机" required hint="支持粘贴 user@host:port，会自动拆开">
                <Input
                  value={draft.host || ""}
                  onChange={(e) => setDraft({ ...draft, host: e.target.value })}
                  onPaste={(e) => {
                    const text = e.clipboardData.getData("text")
                    if (text && (text.includes(":") || text.includes("@"))) {
                      e.preventDefault()
                      onHostPaste(text)
                    }
                  }}
                  placeholder="10.0.0.1 / db.internal"
                />
              </Field>
              <Field label="端口">
                <Input
                  type="number"
                  value={draft.port ?? ""}
                  onChange={(e) => setDraft({ ...draft, port: Number(e.target.value) })}
                  placeholder={String(defaultPort(draft.protocol as NodeProtocol))}
                />
              </Field>
            </FieldGrid>

            <FieldGrid>
              <Field label="登录用户名" hint="远端节点上的账号，不是堡垒机本身的">
                <Input
                  value={draft.username || ""}
                  onChange={(e) => setDraft({ ...draft, username: e.target.value })}
                  placeholder="root / Administrator / 留空走凭据"
                />
              </Field>
              <Field label="凭据" required>
                <Select
                  value={draft.credential_id ? String(draft.credential_id) : ""}
                  onValueChange={(v) => setDraft({ ...draft, credential_id: Number(v) })}
                >
                  <SelectTrigger>
                    <SelectValue placeholder={credentials.length ? "选择凭据" : "尚未配置凭据"} />
                  </SelectTrigger>
                  <SelectContent>
                    {credentials.map((c) => (
                      <SelectItem key={c.id} value={String(c.id)}>
                        {c.name}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </Field>
            </FieldGrid>
          </section>

          <Separator />

          {/* 代理链 */}
          <CollapsibleSection
            title="代理链"
            summary={
              chainIDs.length === 0
                ? "直连"
                : chainIDs
                    .map((id) => proxies.find((p) => p.id === id)?.name ?? `#${id}`)
                    .join(" → ")
            }
          >
            <ProxyChainEditor proxies={proxies} value={chainIDs} onChange={setChain} />
          </CollapsibleSection>

          {/* 元数据 */}
          <CollapsibleSection
            title="标签与元数据"
            summary={[draft.region, draft.tags].filter(Boolean).join(" · ") || "未设置"}
          >
            <FieldGrid>
              <Field label="区域">
                <Input
                  value={draft.region || ""}
                  onChange={(e) => setDraft({ ...draft, region: e.target.value })}
                  placeholder="cn-hangzhou / dc1"
                />
              </Field>
              <Field label="标签">
                <TagChips
                  value={draft.tags || ""}
                  onChange={(v) => setDraft({ ...draft, tags: v })}
                  placeholder="回车或逗号确认"
                />
              </Field>
            </FieldGrid>
            <Field label="描述" className="mt-3">
              <Textarea
                rows={2}
                value={draft.description || ""}
                onChange={(e) => setDraft({ ...draft, description: e.target.value })}
                placeholder="一句话说明这台机器是做什么的，会出现在节点详情里"
              />
            </Field>
          </CollapsibleSection>

          {/* 协议参数 — RDP 默认展开，其它协议默认收起 */}
          <CollapsibleSection
            title="协议参数"
            summary={
              draft.protocol === "rdp"
                ? "RDP 安全协议、显示、性能等"
                : draft.proto_options
                ? "已设置 JSON"
                : "默认"
            }
            defaultOpen={draft.protocol === "rdp"}
          >
            {draft.protocol === "rdp" ? (
              <RdpOptionsForm
                value={draft.proto_options}
                onChange={(v) => setDraft({ ...draft, proto_options: v })}
              />
            ) : (
              <Field
                label="JSON 覆盖"
                hint="留空走协议默认值；只有需要覆盖时填写"
              >
                <Textarea
                  rows={4}
                  className="font-mono text-xs"
                  value={draft.proto_options || ""}
                  onChange={(e) => setDraft({ ...draft, proto_options: e.target.value })}
                  placeholder={protoOptionsExample(draft.protocol as NodeProtocol)}
                />
              </Field>
            )}
          </CollapsibleSection>
        </div>

        <SheetFooter className="border-t px-6 py-4 flex-row justify-end gap-2 shrink-0">
          <Button variant="outline" onClick={() => setOpen(false)}>
            取消
          </Button>
          <Button onClick={() => create.mutate()} disabled={!canSubmit || create.isPending}>
            {create.isPending ? "保存中…" : "保存"}
          </Button>
        </SheetFooter>
      </SheetContent>
    </Sheet>
  )
}

// ----- helpers + small composable bits --------------------------------------

function initialDraft(): Partial<Node> & { credential_id?: number } {
  return {
    protocol: "ssh",
    port: 22,
    name: "",
    host: "",
    username: "",
  }
}

function defaultPort(p: NodeProtocol): number {
  return (
    { ssh: 22, telnet: 23, rdp: 3389, vnc: 5900, mysql: 3306, postgres: 5432, redis: 6379, mongo: 27017, tcp: 0 }[p] ?? 0
  )
}

function protoOptionsExample(p: NodeProtocol): string {
  switch (p) {
    case "vnc":
      return '{ "color_depth": 24 }'
    case "mysql":
    case "postgres":
      return '{ "database": "main" }'
    case "mongo":
      return '{ "auth_db": "admin" }'
    case "tcp":
      return ""
    default:
      return "{}"
  }
}

function parseChain(s?: string): number[] {
  if (!s) return []
  return s
    .split(",")
    .map((x) => Number(x.trim()))
    .filter((n) => Number.isFinite(n) && n > 0)
}

function Field({
  label,
  required,
  hint,
  className,
  children,
}: {
  label: string
  required?: boolean
  hint?: string
  className?: string
  children: React.ReactNode
}) {
  return (
    <div className={cn("space-y-1.5", className)}>
      <Label className="text-xs font-medium text-foreground/80">
        {label}
        {required && <span className="ml-1 text-destructive">*</span>}
      </Label>
      {children}
      {hint && <p className="text-[11px] text-muted-foreground leading-relaxed">{hint}</p>}
    </div>
  )
}

function FieldGrid({
  children,
  cols,
}: {
  children: React.ReactNode
  cols?: [number, number]
}) {
  if (cols) {
    const total = cols[0] + cols[1]
    return (
      <div className={`grid gap-3`} style={{ gridTemplateColumns: cols.map((c) => `${c}fr`).join(" ") }}>
        {children}
      </div>
    )
  }
  return <div className="grid grid-cols-2 gap-3">{children}</div>
}

function CollapsibleSection({
  title,
  summary,
  defaultOpen,
  children,
}: {
  title: string
  summary?: string
  defaultOpen?: boolean
  children: React.ReactNode
}) {
  const [open, setOpen] = React.useState(!!defaultOpen)
  return (
    <Collapsible open={open} onOpenChange={setOpen}>
      <CollapsibleTrigger
        className={cn(
          "w-full flex items-center justify-between gap-3 py-2 group select-none",
          "rounded-md hover:bg-muted/40 px-2 -mx-2 transition-colors"
        )}
      >
        <div className="flex items-center gap-2 min-w-0">
          <ChevronDown
            className={cn(
              "w-4 h-4 shrink-0 text-muted-foreground transition-transform",
              open ? "rotate-0" : "-rotate-90"
            )}
          />
          <span className="text-sm font-medium">{title}</span>
          {!open && summary && (
            <span className="text-xs text-muted-foreground truncate">— {summary}</span>
          )}
        </div>
      </CollapsibleTrigger>
      <CollapsibleContent className="pt-2 px-1">{children}</CollapsibleContent>
    </Collapsible>
  )
}

// ----- ProxyChainEditor: chip-based ordered list editor ---------------------

function ProxyChainEditor({
  proxies,
  value,
  onChange,
}: {
  proxies: Proxy[]
  value: number[]
  onChange: (next: number[]) => void
}) {
  const selectedSet = new Set(value)
  const available = proxies.filter((p) => !selectedSet.has(p.id))

  const move = (idx: number, delta: number) => {
    const next = [...value]
    const target = idx + delta
    if (target < 0 || target >= next.length) return
    ;[next[idx], next[target]] = [next[target], next[idx]]
    onChange(next)
  }

  return (
    <div className="space-y-3">
      {value.length === 0 ? (
        <p className="text-xs text-muted-foreground py-2">
          未选择代理 = 直连。点击下方代理可加入链路；最外层在最左。
        </p>
      ) : (
        <ol className="space-y-1.5">
          {value.map((id, i) => {
            const p = proxies.find((x) => x.id === id)
            return (
              <li
                key={id}
                className="flex items-center gap-2 rounded-md border bg-muted/30 px-2 py-1.5 text-sm"
              >
                <span className="text-xs text-muted-foreground w-5 text-center font-mono">{i + 1}</span>
                <Badge variant="secondary" className="font-mono text-[10px]">
                  {p?.kind ?? "?"}
                </Badge>
                <span className="flex-1 truncate">
                  {p?.name ?? `代理 #${id} (已删除)`}
                  {p && (
                    <span className="ml-2 text-xs text-muted-foreground">
                      {p.host}:{p.port}
                    </span>
                  )}
                </span>
                <Button
                  type="button"
                  variant="ghost"
                  size="icon"
                  className="h-7 w-7"
                  disabled={i === 0}
                  onClick={() => move(i, -1)}
                >
                  <ArrowUp className="w-3.5 h-3.5" />
                </Button>
                <Button
                  type="button"
                  variant="ghost"
                  size="icon"
                  className="h-7 w-7"
                  disabled={i === value.length - 1}
                  onClick={() => move(i, +1)}
                >
                  <ArrowDown className="w-3.5 h-3.5" />
                </Button>
                <Button
                  type="button"
                  variant="ghost"
                  size="icon"
                  className="h-7 w-7"
                  onClick={() => onChange(value.filter((x) => x !== id))}
                >
                  <X className="w-3.5 h-3.5" />
                </Button>
              </li>
            )
          })}
        </ol>
      )}

      {available.length > 0 && (
        <div>
          <div className="text-[11px] text-muted-foreground mb-1.5">可用代理</div>
          <div className="flex flex-wrap gap-1.5">
            {available.map((p) => (
              <button
                key={p.id}
                type="button"
                onClick={() => onChange([...value, p.id])}
                className="inline-flex items-center gap-1 rounded-md border px-2 py-1 text-xs hover:bg-accent hover:text-accent-foreground transition-colors"
              >
                <span className="font-mono text-[10px] text-muted-foreground">{p.kind}</span>
                <span>{p.name}</span>
              </button>
            ))}
          </div>
        </div>
      )}
    </div>
  )
}

// ----- TagChips: comma/enter to add, click X to remove ---------------------

function TagChips({
  value,
  onChange,
  placeholder,
}: {
  value: string
  onChange: (next: string) => void
  placeholder?: string
}) {
  const tags = value
    .split(",")
    .map((t) => t.trim())
    .filter(Boolean)
  const [buf, setBuf] = React.useState("")

  const commit = (raw: string) => {
    const t = raw.trim()
    if (!t || tags.includes(t)) {
      setBuf("")
      return
    }
    onChange([...tags, t].join(","))
    setBuf("")
  }

  return (
    <div className="rounded-md border border-input bg-transparent px-2 py-1.5 min-h-9 flex flex-wrap gap-1.5 items-center">
      {tags.map((t) => (
        <span
          key={t}
          className="inline-flex items-center gap-1 rounded bg-secondary text-secondary-foreground px-1.5 py-0.5 text-xs"
        >
          {t}
          <button
            type="button"
            className="opacity-60 hover:opacity-100"
            onClick={() => onChange(tags.filter((x) => x !== t).join(","))}
          >
            <X className="w-3 h-3" />
          </button>
        </span>
      ))}
      <input
        className="flex-1 min-w-[6rem] bg-transparent outline-none text-sm placeholder:text-muted-foreground"
        value={buf}
        onChange={(e) => {
          const v = e.target.value
          if (v.endsWith(",")) commit(v.slice(0, -1))
          else setBuf(v)
        }}
        onKeyDown={(e) => {
          if (e.key === "Enter") {
            e.preventDefault()
            commit(buf)
          } else if (e.key === "Backspace" && buf === "" && tags.length > 0) {
            onChange(tags.slice(0, -1).join(","))
          }
        }}
        onBlur={() => buf && commit(buf)}
        placeholder={tags.length === 0 ? placeholder : ""}
      />
    </div>
  )
}
