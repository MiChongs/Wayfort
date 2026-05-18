"use client"

import * as React from "react"
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query"
import {
  AlertTriangle,
  Copy,
  Loader2,
  Plus,
  Power,
  RefreshCw,
  Shield,
  Stethoscope,
  Trash2,
} from "lucide-react"
import { toast } from "sonner"
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
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
  SheetHeader,
  SheetTitle,
} from "@/components/ui/sheet"
import { firewallService } from "@/lib/api/services"
import type { FirewallDiagnostics, FirewallRuleSpec } from "@/lib/api/types"

type Props = {
  nodeId: number
  active: boolean
}

// Maps the typed error code/text from the backend to a UI hint. Keeps the
// terminology consistent with what the Diagnose endpoint surfaces so
// operators read the same language across the toast / alert / sheet.
function errorHint(code: string | undefined, msg: string): string {
  if (code === "permission_denied" || /root|sudo|permission denied|operation not permitted/i.test(msg)) {
    return "SSH 用户没有权限执行防火墙命令。改用 root 凭据,或在节点上为 ufw / iptables / nft 配 sudoers NOPASSWD。"
  }
  if (code === "unreachable" || /timeout|unreachable|no route to host|connection refused/i.test(msg)) {
    return "节点 SSH 不可达。检查节点状态、代理链和凭据。"
  }
  if (code === "no_tool" || /no firewall|not installed/i.test(msg)) {
    return "节点上没装 ufw / firewalld / nft / iptables。SSH 进去手动装一个,然后回来刷新。"
  }
  if (code === "subsystem_unavailable" || /subsystem|not initialised|predate/i.test(msg)) {
    return "网关二进制没编译进防火墙模块。让管理员从最新源码重建网关再启动。"
  }
  if (code === "parse_error") {
    return "解析防火墙工具输出失败。点 \"诊断\" 看 raw probe 协助定位。"
  }
  return ""
}

type ApiError = { message?: string; status?: number; detail?: { code?: string } | unknown }

function codeOf(e: unknown): string | undefined {
  if (e && typeof e === "object" && "detail" in e) {
    const d = (e as ApiError).detail
    if (d && typeof d === "object" && "code" in d) return String((d as { code?: string }).code ?? "") || undefined
  }
  return undefined
}

export function FirewallTab({ nodeId, active }: Props) {
  const qc = useQueryClient()
  const status = useQuery({
    queryKey: ["firewall", nodeId, "status"],
    queryFn: () => firewallService.status(nodeId),
    enabled: active,
    refetchInterval: 30_000,
    retry: false,
  })
  const rules = useQuery({
    queryKey: ["firewall", nodeId, "rules"],
    queryFn: () => firewallService.listRules(nodeId),
    enabled: active && (status.data?.tool ?? "") !== "",
    refetchInterval: 30_000,
    retry: false,
  })

  const [adding, setAdding] = React.useState(false)
  const [diagnoseOpen, setDiagnoseOpen] = React.useState(false)

  const invalidate = React.useCallback(() => {
    void qc.invalidateQueries({ queryKey: ["firewall", nodeId] })
  }, [nodeId, qc])

  const deleteRule = useMutation({
    mutationFn: (index: number) => firewallService.deleteRule(nodeId, index),
    onSuccess: () => {
      toast.success("已删除规则")
      invalidate()
    },
    onError: (e: ApiError) =>
      toast.error("删除失败", { description: e?.message }),
  })

  const setEnabled = useMutation({
    mutationFn: (on: boolean) =>
      on ? firewallService.enable(nodeId) : firewallService.disable(nodeId),
    onSuccess: (_data, on) => {
      toast.success(on ? "已启用防火墙" : "已停用防火墙")
      invalidate()
    },
    onError: (e: ApiError) =>
      toast.error("切换失败", { description: e?.message }),
  })

  // Group rules by chain (iptables/nft surface multiple chains; ufw and
  // firewalld emit only one effective chain so the grouping collapses).
  // MUST be declared before any conditional early-return below so the
  // hook call order stays stable across renders — moving this past the
  // loading / error branches caused the "change in the order of Hooks"
  // warning in React strict mode.
  const grouped = React.useMemo(() => {
    const groups: Record<string, NonNullable<typeof rules.data>["rules"]> = {}
    const list = rules.data?.rules ?? []
    for (const r of list) {
      const key = r.chain || "rules"
      if (!groups[key]) groups[key] = []
      groups[key].push(r)
    }
    return groups
  }, [rules.data])

  if (!active) return null

  if (status.isLoading) {
    return (
      <div className="flex items-center gap-2 text-sm text-muted-foreground p-6">
        <Loader2 className="w-4 h-4 animate-spin" /> 检测防火墙工具中…
      </div>
    )
  }

  if (status.isError) {
    const err = status.error as ApiError
    const code = codeOf(err)
    const msg = err?.message || "未知错误"
    return (
      <div className="p-4 space-y-3">
        <Alert variant="destructive">
          <AlertTriangle className="w-4 h-4" />
          <AlertTitle>查询失败</AlertTitle>
          <AlertDescription>
            <div className="text-xs font-mono break-words mt-1">{msg}</div>
            {errorHint(code, msg) && (
              <div className="text-xs text-foreground/80 mt-2">{errorHint(code, msg)}</div>
            )}
          </AlertDescription>
        </Alert>
        <div className="flex gap-1.5">
          <Button size="sm" variant="outline" className="h-7 text-xs" onClick={() => status.refetch()}>
            <RefreshCw className="w-3 h-3" /> 重试
          </Button>
          <Button size="sm" variant="outline" className="h-7 text-xs" onClick={() => setDiagnoseOpen(true)}>
            <Stethoscope className="w-3 h-3" /> 诊断
          </Button>
        </div>
        <DiagnoseSheet nodeId={nodeId} open={diagnoseOpen} onOpenChange={setDiagnoseOpen} />
      </div>
    )
  }

  const s = status.data
  if (!s || s.tool === "") {
    return (
      <div className="p-6 text-center text-sm text-muted-foreground space-y-2">
        <Shield className="w-8 h-8 mx-auto opacity-50" />
        <div className="font-medium text-foreground">未检测到防火墙工具</div>
        <div className="text-xs">
          {s?.reason || "节点上未安装 ufw / firewalld / nft / iptables"}
        </div>
        <Button size="sm" variant="outline" className="h-7 text-xs" onClick={() => setDiagnoseOpen(true)}>
          <Stethoscope className="w-3 h-3" /> 诊断
        </Button>
        <DiagnoseSheet nodeId={nodeId} open={diagnoseOpen} onOpenChange={setDiagnoseOpen} />
      </div>
    )
  }

  return (
    <div className="flex flex-col h-full">
      <header className="flex items-center justify-between gap-2 px-3 py-2 border-b bg-card">
        <div className="flex items-center gap-2 min-w-0">
          <Shield className="w-4 h-4 text-primary" />
          <Badge variant="outline" className="text-[10px] uppercase">
            {s.tool}
          </Badge>
          <Badge variant={s.active ? "success" : "secondary"}>
            {s.active ? "active" : "inactive"}
          </Badge>
          {s.policy && (
            <span className="text-[10px] text-muted-foreground truncate">{s.policy}</span>
          )}
        </div>
        <div className="flex items-center gap-1 shrink-0">
          {(s.tool === "ufw" || s.tool === "firewalld") && (
            <Button
              size="sm"
              variant="outline"
              className="h-7 text-xs"
              onClick={() => setEnabled.mutate(!s.active)}
              disabled={setEnabled.isPending}
            >
              <Power className="w-3 h-3" /> {s.active ? "停用" : "启用"}
            </Button>
          )}
          <Button size="sm" variant="outline" className="h-7 text-xs" onClick={() => setAdding(true)}>
            <Plus className="w-3 h-3" /> 添加
          </Button>
          <Button
            variant="ghost"
            size="icon"
            className="h-7 w-7"
            title="诊断"
            onClick={() => setDiagnoseOpen(true)}
          >
            <Stethoscope className="w-3.5 h-3.5" />
          </Button>
          <Button
            variant="ghost"
            size="icon"
            className="h-7 w-7"
            onClick={() => invalidate()}
            title="刷新"
          >
            <RefreshCw className={`w-3 h-3 ${status.isFetching || rules.isFetching ? "animate-spin" : ""}`} />
          </Button>
        </div>
      </header>

      <div className="flex-1 overflow-auto">
        {rules.isLoading && (
          <div className="text-xs text-muted-foreground p-6 inline-flex items-center gap-2">
            <Loader2 className="w-3 h-3 animate-spin" /> 加载规则…
          </div>
        )}
        {rules.data && rules.data.rules.length === 0 && (
          <div className="text-xs text-muted-foreground p-6 text-center">
            没有规则。点上方"添加"创建第一条。
          </div>
        )}
        {rules.data && rules.data.rules.length > 0 && (
          <div className="divide-y">
            {Object.entries(grouped).map(([chain, group]) => (
              <RuleSection
                key={chain}
                chain={chain}
                rules={group as typeof rules.data.rules}
                onDelete={(idx) => {
                  if (confirm(`删除规则 ${idx}?`)) deleteRule.mutate(idx)
                }}
              />
            ))}
          </div>
        )}
      </div>

      <AddRuleDialog
        open={adding}
        nodeId={nodeId}
        onClose={() => setAdding(false)}
        onAdded={() => {
          setAdding(false)
          invalidate()
        }}
      />
      <DiagnoseSheet nodeId={nodeId} open={diagnoseOpen} onOpenChange={setDiagnoseOpen} />
    </div>
  )
}

function RuleSection({
  chain,
  rules,
  onDelete,
}: {
  chain: string
  rules: { index: number; action: string; direction: string; protocol?: string; port?: string; source?: string; family?: string; raw: string }[]
  onDelete: (idx: number) => void
}) {
  return (
    <section>
      {chain !== "rules" && (
        <div className="px-3 py-1.5 text-[10px] uppercase tracking-wide text-muted-foreground bg-muted/30 sticky top-0">
          {chain} 链 · {rules.length}
        </div>
      )}
      <table className="w-full text-xs">
        <thead className="bg-muted/30 text-[10px] uppercase text-muted-foreground">
          <tr>
            <th className="text-left px-2 py-1.5 w-10">#</th>
            <th className="text-left px-2 py-1.5 w-16">动作</th>
            <th className="text-left px-2 py-1.5 w-14">方向</th>
            <th className="text-left px-2 py-1.5 w-14">家族</th>
            <th className="text-left px-2 py-1.5 w-14">协议</th>
            <th className="text-left px-2 py-1.5">端口</th>
            <th className="text-left px-2 py-1.5">来源</th>
            <th className="px-2 py-1.5 w-8"></th>
          </tr>
        </thead>
        <tbody className="divide-y">
          {rules.map((r) => (
            <tr key={`${chain}:${r.index}`} className="hover:bg-accent/40" title={r.raw}>
              <td className="px-2 py-1.5 tabular-nums text-muted-foreground">{r.index}</td>
              <td className="px-2 py-1.5">
                <Badge variant={r.action === "ALLOW" ? "success" : "destructive"}>
                  {r.action}
                </Badge>
              </td>
              <td className="px-2 py-1.5 text-muted-foreground">{r.direction || "—"}</td>
              <td className="px-2 py-1.5">
                {r.family === "inet" ? (
                  <Badge variant="outline" className="text-[10px]">v4</Badge>
                ) : r.family === "inet6" ? (
                  <Badge variant="outline" className="text-[10px]">v6</Badge>
                ) : (
                  <span className="text-muted-foreground">—</span>
                )}
              </td>
              <td className="px-2 py-1.5 text-muted-foreground">{r.protocol || "any"}</td>
              <td className="px-2 py-1.5 font-mono">{r.port || "any"}</td>
              <td className="px-2 py-1.5 font-mono truncate max-w-[10rem]">
                {r.source || "Anywhere"}
              </td>
              <td className="px-2 py-1.5 text-right">
                <Button
                  variant="ghost"
                  size="icon"
                  className="h-6 w-6 text-destructive hover:text-destructive"
                  title="删除规则"
                  onClick={() => onDelete(r.index)}
                >
                  <Trash2 className="w-3 h-3" />
                </Button>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </section>
  )
}

function DiagnoseSheet({
  nodeId,
  open,
  onOpenChange,
}: {
  nodeId: number
  open: boolean
  onOpenChange: (v: boolean) => void
}) {
  const diag = useQuery({
    queryKey: ["firewall", nodeId, "diagnose"],
    queryFn: () => firewallService.diagnose(nodeId),
    enabled: open,
    retry: false,
  })

  const copy = (d: FirewallDiagnostics | undefined) => {
    if (!d) return
    void navigator.clipboard?.writeText(JSON.stringify(d, null, 2))
    toast.success("已复制诊断输出")
  }

  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetContent side="right" className="w-[min(520px,calc(100vw-2rem))] sm:max-w-none flex flex-col gap-3">
        <SheetHeader>
          <SheetTitle>防火墙诊断</SheetTitle>
          <SheetDescription>
            运行的探测全部展示在这里 — 不写入任何规则,仅观察。
          </SheetDescription>
        </SheetHeader>
        <div className="flex-1 overflow-y-auto px-1">
          {diag.isLoading && (
            <div className="text-xs text-muted-foreground inline-flex items-center gap-2 py-4">
              <Loader2 className="w-3.5 h-3.5 animate-spin" /> 探测中…
            </div>
          )}
          {diag.isError && (
            <div className="text-xs text-destructive py-4 break-words">
              {(diag.error as ApiError)?.message || "诊断失败"}
            </div>
          )}
          {diag.data && (
            <dl className="text-xs space-y-2">
              <Field label="UID">
                <span className="font-mono">{diag.data.uid}</span>
                {diag.data.is_root && (
                  <Badge variant="success" className="ml-2 text-[10px]">root</Badge>
                )}
              </Field>
              <Field label="sudo 可用">
                {diag.data.sudo_available ? "是" : "否"}
              </Field>
              {diag.data.sudo_nopasswd_tools && diag.data.sudo_nopasswd_tools.length > 0 && (
                <Field label="NOPASSWD 包含">
                  <div className="flex gap-1 flex-wrap">
                    {diag.data.sudo_nopasswd_tools.map((t) => (
                      <Badge key={t} variant="outline" className="text-[10px] font-mono">{t}</Badge>
                    ))}
                  </div>
                </Field>
              )}
              <Field label="检测到的工具">
                {diag.data.tools_found && diag.data.tools_found.length > 0 ? (
                  <div className="flex gap-1 flex-wrap">
                    {diag.data.tools_found.map((t) => (
                      <Badge key={t} variant="outline" className="text-[10px] font-mono">{t}</Badge>
                    ))}
                  </div>
                ) : (
                  <span className="text-muted-foreground">无</span>
                )}
              </Field>
              <Field label="选用的工具">
                {diag.data.selected_tool ? (
                  <Badge variant="default" className="text-[10px] uppercase">{diag.data.selected_tool}</Badge>
                ) : (
                  <span className="text-muted-foreground">—</span>
                )}
              </Field>
              <Field label="探测耗时">
                <span className="font-mono">{diag.data.elapsed_ms} ms</span>
              </Field>
              {diag.data.last_error && (
                <Field label="错误">
                  <span className="text-destructive font-mono">{diag.data.last_error}</span>
                </Field>
              )}
              <div>
                <div className="text-[10px] uppercase tracking-wide text-muted-foreground mt-3 mb-1">
                  原始 probe stdout
                </div>
                <pre className="bg-muted rounded-md p-2 text-[11px] font-mono whitespace-pre overflow-x-auto">
                  {diag.data.probe_raw || "(空)"}
                </pre>
              </div>
            </dl>
          )}
        </div>
        <div className="flex justify-end gap-1.5 pt-2 border-t">
          <Button size="sm" variant="outline" className="h-7 text-xs" onClick={() => diag.refetch()}>
            <RefreshCw className={`w-3 h-3 ${diag.isFetching ? "animate-spin" : ""}`} /> 重试
          </Button>
          <Button size="sm" variant="outline" className="h-7 text-xs" onClick={() => copy(diag.data)}>
            <Copy className="w-3 h-3" /> 复制 JSON
          </Button>
        </div>
      </SheetContent>
    </Sheet>
  )
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="grid grid-cols-[7rem_1fr] items-center gap-2">
      <dt className="text-muted-foreground">{label}</dt>
      <dd>{children}</dd>
    </div>
  )
}

function AddRuleDialog({
  open,
  nodeId,
  onClose,
  onAdded,
}: {
  open: boolean
  nodeId: number
  onClose: () => void
  onAdded: () => void
}) {
  const [action, setAction] = React.useState<"ALLOW" | "DENY" | "REJECT">("ALLOW")
  const [protocol, setProtocol] = React.useState<"tcp" | "udp">("tcp")
  const [port, setPort] = React.useState("")
  const [source, setSource] = React.useState("")

  React.useEffect(() => {
    if (open) {
      setAction("ALLOW")
      setProtocol("tcp")
      setPort("")
      setSource("")
    }
  }, [open])

  const submit = useMutation({
    mutationFn: (spec: FirewallRuleSpec) => firewallService.addRule(nodeId, spec),
    onSuccess: () => {
      toast.success("已添加规则")
      onAdded()
    },
    onError: (e: ApiError) =>
      toast.error("添加失败", { description: e?.message }),
  })

  const invalid = !port.trim() || submit.isPending

  return (
    <Dialog open={open} onOpenChange={(v) => !v && onClose()}>
      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle>添加防火墙规则</DialogTitle>
          <DialogDescription>
            规则会落到节点上的 ufw / firewalld / nft / iptables;操作会被审计记录。
          </DialogDescription>
        </DialogHeader>
        <div className="space-y-3 py-1">
          <div className="grid grid-cols-2 gap-2">
            <div className="space-y-1">
              <Label className="text-xs">动作</Label>
              <Select value={action} onValueChange={(v) => setAction(v as "ALLOW" | "DENY" | "REJECT")}>
                <SelectTrigger className="h-9">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="ALLOW">ALLOW（放行）</SelectItem>
                  <SelectItem value="DENY">DENY（丢弃）</SelectItem>
                  <SelectItem value="REJECT">REJECT（拒绝）</SelectItem>
                </SelectContent>
              </Select>
            </div>
            <div className="space-y-1">
              <Label className="text-xs">协议</Label>
              <Select value={protocol} onValueChange={(v) => setProtocol(v as "tcp" | "udp")}>
                <SelectTrigger className="h-9">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="tcp">TCP</SelectItem>
                  <SelectItem value="udp">UDP</SelectItem>
                </SelectContent>
              </Select>
            </div>
          </div>
          <div className="space-y-1">
            <Label className="text-xs" htmlFor="fw-port">端口 *</Label>
            <Input
              id="fw-port"
              value={port}
              onChange={(e) => setPort(e.target.value)}
              placeholder="22 / 80,443 / 8000:9000"
              className="font-mono"
            />
          </div>
          <div className="space-y-1">
            <Label className="text-xs" htmlFor="fw-source">来源 CIDR（可空 = Anywhere）</Label>
            <Input
              id="fw-source"
              value={source}
              onChange={(e) => setSource(e.target.value)}
              placeholder="10.0.0.0/8"
              className="font-mono"
            />
          </div>
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={onClose} disabled={submit.isPending}>
            取消
          </Button>
          <Button
            onClick={() =>
              submit.mutate({
                action,
                protocol,
                port: port.trim(),
                source: source.trim() || undefined,
                direction: "in",
              })
            }
            disabled={invalid}
          >
            {submit.isPending ? "添加中…" : "添加"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
