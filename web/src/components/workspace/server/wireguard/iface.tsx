"use client"

import * as React from "react"
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query"
import {
  Eye,
  EyeOff,
  Loader2,
  Pencil,
  Power,
  PowerOff,
  RefreshCw,
  RotateCw,
  Trash2,
  Waypoints,
} from "lucide-react"
import { toast } from "@/components/ui/sonner"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Card, CardContent } from "@/components/ui/card"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { Switch } from "@/components/ui/switch"
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog"
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select"
import { CopyButton } from "@/components/common/copy-button"
import {
  wireguardService,
  type WGCreateIfaceReq,
  type WGIface,
  type WGKeyPair,
} from "@/lib/api/services"
import { codeOf, RunInTerminalButton, type ApiError } from "../_shared"
import { errorHint } from "./shared"

const splitCSV = (s: string): string[] =>
  s.split(",").map((x) => x.trim()).filter(Boolean)

function onErr(e: ApiError) {
  toast.error("操作失败", { description: errorHint(codeOf(e), e?.message || "") || e?.message })
}

// ---- interface card ----

export function IfaceCard({
  ifc,
  busy,
  tabId,
  onToggle,
  onToggleAutostart,
  onEdit,
  onDelete,
  onApply,
  onViewPeers,
}: {
  ifc: WGIface
  busy: boolean
  tabId: string
  onToggle: (name: string, up: boolean) => void
  onToggleAutostart: (name: string, on: boolean) => void
  onEdit: (name: string) => void
  onDelete: (name: string) => void
  onApply: (name: string) => void
  onViewPeers: (name: string) => void
}) {
  const peers = ifc.peers ?? []
  const addrs = ifc.addresses ?? []
  return (
    <Card>
      <CardContent className="space-y-2 px-3 py-2.5">
        <div className="flex items-center justify-between gap-2">
          <div className="flex min-w-0 items-center gap-1.5">
            <Waypoints className="h-3.5 w-3.5 shrink-0 text-primary" />
            <span className="truncate font-mono text-xs font-medium">{ifc.name}</span>
            {ifc.up ? (
              <Badge className="h-4 shrink-0 border-success/40 bg-success/[0.08] px-1.5 text-[10px] text-success">运行</Badge>
            ) : (
              <Badge variant="secondary" className="h-4 shrink-0 px-1.5 text-[10px]">停止</Badge>
            )}
            {ifc.listen_port > 0 && (
              <Badge variant="outline" className="h-4 shrink-0 px-1.5 text-[10px]">:{ifc.listen_port}</Badge>
            )}
            <Badge variant="secondary" className="h-4 shrink-0 px-1.5 text-[10px]">{peers.length} 对端</Badge>
          </div>
          <div className="inline-flex shrink-0 items-center gap-0.5">
            <RunInTerminalButton tabId={tabId} command={`wg show ${ifc.name}`} run={false} label="wg show" />
            <Button variant="ghost" size="icon" className="h-6 w-6" title="应用配置（热同步）" disabled={busy || !ifc.up} onClick={() => onApply(ifc.name)}>
              <RotateCw className="h-3 w-3" />
            </Button>
            <Button variant="ghost" size="icon" className="h-6 w-6" title="编辑" disabled={busy} onClick={() => onEdit(ifc.name)}>
              <Pencil className="h-3 w-3" />
            </Button>
            {ifc.up ? (
              <Button variant="ghost" size="icon" className="h-6 w-6 text-destructive" title="停止 (wg-quick down)" disabled={busy} onClick={() => onToggle(ifc.name, false)}>
                <PowerOff className="h-3 w-3" />
              </Button>
            ) : (
              <Button variant="ghost" size="icon" className="h-6 w-6" title="启动 (wg-quick up)" disabled={busy} onClick={() => onToggle(ifc.name, true)}>
                <Power className="h-3 w-3" />
              </Button>
            )}
            <Button variant="ghost" size="icon" className="h-6 w-6 text-destructive" title="删除接口" disabled={busy} onClick={() => onDelete(ifc.name)}>
              <Trash2 className="h-3 w-3" />
            </Button>
          </div>
        </div>

        <div className="grid grid-cols-1 gap-x-3 gap-y-0.5 text-[10px] text-muted-foreground sm:grid-cols-2">
          {addrs.length > 0 && (
            <div className="truncate" title={addrs.join(", ")}>地址 <span className="font-mono text-foreground/80">{addrs.join(", ")}</span></div>
          )}
          {ifc.mtu ? <div>MTU <span className="font-mono text-foreground/80">{ifc.mtu}</span></div> : null}
          {ifc.dns && ifc.dns.length > 0 && (
            <div className="truncate" title={ifc.dns.join(", ")}>DNS <span className="font-mono text-foreground/80">{ifc.dns.join(", ")}</span></div>
          )}
          {ifc.public_key && (
            <div className="flex items-center gap-1 truncate sm:col-span-2" title={ifc.public_key}>
              公钥 <span className="truncate font-mono text-foreground/80">{ifc.public_key}</span>
              <CopyButton value={ifc.public_key} className="h-4 w-4" />
            </div>
          )}
        </div>

        <div className="flex items-center justify-between gap-2 pt-0.5">
          <label className="flex items-center gap-1.5 text-[10px] text-muted-foreground">
            <Switch checked={ifc.autostart} disabled={busy} onCheckedChange={(v) => onToggleAutostart(ifc.name, v)} />
            开机自启
          </label>
          <Button variant="link" size="sm" className="h-6 px-0 text-[11px]" onClick={() => onViewPeers(ifc.name)}>
            查看 {peers.length} 个对端 →
          </Button>
        </div>
      </CardContent>
    </Card>
  )
}

// ---- create wizard ----

const STEPS = ["命名", "密钥", "网络", "网关"] as const

export function CreateIfaceWizard({
  nodeId,
  open,
  onClose,
}: {
  nodeId: number
  open: boolean
  onClose: () => void
}) {
  const qc = useQueryClient()
  const [step, setStep] = React.useState(0)
  const [name, setName] = React.useState("wg0")
  const [address, setAddress] = React.useState("10.8.0.1/24")
  const [port, setPort] = React.useState("51820")
  const [dns, setDns] = React.useState("1.1.1.1")
  const [mtu, setMtu] = React.useState("")
  const [keys, setKeys] = React.useState<WGKeyPair | null>(null)
  const [showPriv, setShowPriv] = React.useState(false)
  const [enableNat, setEnableNat] = React.useState(false)
  const [egress, setEgress] = React.useState("")
  const [autostart, setAutostart] = React.useState(true)
  const [bringUp, setBringUp] = React.useState(true)

  const gateway = useQuery({
    queryKey: ["wg", nodeId, "gateway"],
    queryFn: () => wireguardService.gateway(nodeId),
    enabled: open,
  })
  React.useEffect(() => {
    if (gateway.data?.egress_iface && !egress) setEgress(gateway.data.egress_iface)
  }, [gateway.data, egress])

  const genKeys = useMutation({
    mutationFn: () => wireguardService.genKeys(nodeId),
    onSuccess: (kp) => setKeys(kp),
    onError: onErr,
  })

  // Reset + generate keys when opened.
  React.useEffect(() => {
    if (!open) return
    setStep(0)
    setName("wg0")
    setAddress("10.8.0.1/24")
    setPort("51820")
    setDns("1.1.1.1")
    setMtu("")
    setKeys(null)
    setShowPriv(false)
    setEnableNat(false)
    setAutostart(true)
    setBringUp(true)
    genKeys.mutate()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open])

  const create = useMutation({
    mutationFn: () => {
      const body: WGCreateIfaceReq = {
        name: name.trim(),
        address: splitCSV(address),
        listen_port: port ? Number(port) : undefined,
        dns: splitCSV(dns),
        mtu: mtu ? Number(mtu) : undefined,
        private_key: keys?.private_key,
        enable_nat: enableNat,
        nat_egress: enableNat ? egress : undefined,
        autostart,
        bring_up: bringUp,
      }
      return wireguardService.createIface(nodeId, body)
    },
    onSuccess: () => {
      toast.success(`接口 ${name} 已创建`)
      void qc.invalidateQueries({ queryKey: ["wg", nodeId] })
      onClose()
    },
    onError: onErr,
  })

  const canNext =
    (step === 0 && /^[a-z0-9_-]{1,15}$/i.test(name.trim())) ||
    (step === 1 && !!keys) ||
    (step === 2 && splitCSV(address).length > 0) ||
    step === 3
  const last = step === STEPS.length - 1

  return (
    <Dialog open={open} onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle className="text-base font-semibold tracking-tight">新建 WireGuard 接口</DialogTitle>
          <DialogDescription className="flex items-center gap-1">
            {STEPS.map((s, i) => (
              <span key={s} className={i === step ? "text-foreground" : "text-muted-foreground/60"}>
                {i > 0 && <span className="px-1 text-muted-foreground/40">/</span>}
                {s}
              </span>
            ))}
          </DialogDescription>
        </DialogHeader>

        <div className="min-h-[9rem] space-y-3 py-1">
          {step === 0 && (
            <Field label="接口名" hint="仅字母数字/._-，≤15 字符（如 wg0）">
              <Input value={name} onChange={(e) => setName(e.target.value)} placeholder="wg0" className="h-8 font-mono text-xs" />
            </Field>
          )}
          {step === 1 && (
            <div className="space-y-2">
              <Field label="私钥（自动生成，仅服务端保存）">
                <div className="flex items-center gap-1">
                  <Input readOnly value={keys ? (showPriv ? keys.private_key : "•".repeat(44)) : "生成中…"} className="h-8 font-mono text-[11px]" />
                  <Button variant="ghost" size="icon" className="h-8 w-8 shrink-0" onClick={() => setShowPriv((v) => !v)}>
                    {showPriv ? <EyeOff className="h-3.5 w-3.5" /> : <Eye className="h-3.5 w-3.5" />}
                  </Button>
                </div>
              </Field>
              <Field label="公钥">
                <div className="flex items-center gap-1">
                  <Input readOnly value={keys?.public_key ?? ""} className="h-8 font-mono text-[11px]" />
                  {keys && <CopyButton value={keys.public_key} className="h-8 w-8 shrink-0" />}
                </div>
              </Field>
              <Button variant="outline" size="sm" className="h-7 gap-1 text-xs" disabled={genKeys.isPending} onClick={() => genKeys.mutate()}>
                {genKeys.isPending ? <Loader2 className="h-3 w-3 animate-spin" /> : <RefreshCw className="h-3 w-3" />} 重新生成
              </Button>
            </div>
          )}
          {step === 2 && (
            <div className="space-y-2">
              <Field label="地址 (CIDR，可逗号分隔)" hint="服务端隧道地址，如 10.8.0.1/24">
                <Input value={address} onChange={(e) => setAddress(e.target.value)} placeholder="10.8.0.1/24" className="h-8 font-mono text-xs" />
              </Field>
              <div className="grid grid-cols-2 gap-2">
                <Field label="监听端口"><Input value={port} onChange={(e) => setPort(e.target.value)} placeholder="51820" className="h-8 font-mono text-xs" /></Field>
                <Field label="MTU (可选)"><Input value={mtu} onChange={(e) => setMtu(e.target.value)} placeholder="1420" className="h-8 font-mono text-xs" /></Field>
              </div>
              <Field label="DNS (可选，逗号分隔)"><Input value={dns} onChange={(e) => setDns(e.target.value)} placeholder="1.1.1.1" className="h-8 font-mono text-xs" /></Field>
            </div>
          )}
          {step === 3 && (
            <div className="space-y-2.5">
              <Toggle label="启用 NAT 网关（MASQUERADE）" hint="让对端经本机出网；自动开启 IP 转发" checked={enableNat} onChange={setEnableNat} />
              {enableNat && (
                <Field label="出口网卡">
                  <Select value={egress} onValueChange={setEgress}>
                    <SelectTrigger className="h-8 text-xs"><SelectValue placeholder="选择出口网卡" /></SelectTrigger>
                    <SelectContent>
                      {(gateway.data?.egress_candidates ?? []).map((d) => (
                        <SelectItem key={d} value={d} className="font-mono text-xs">{d}</SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </Field>
              )}
              <Toggle label="开机自启 (systemctl enable)" checked={autostart} onChange={setAutostart} />
              <Toggle label="创建后立即启动" checked={bringUp} onChange={setBringUp} />
            </div>
          )}
        </div>

        <DialogFooter className="flex-row items-center justify-between sm:justify-between">
          <Button variant="ghost" size="sm" disabled={step === 0} onClick={() => setStep((s) => Math.max(0, s - 1))}>上一步</Button>
          {last ? (
            <Button size="sm" disabled={create.isPending || !keys || (enableNat && !egress)} onClick={() => create.mutate()}>
              {create.isPending && <Loader2 className="mr-1 h-3 w-3 animate-spin" />} 创建接口
            </Button>
          ) : (
            <Button size="sm" disabled={!canNext} onClick={() => setStep((s) => Math.min(STEPS.length - 1, s + 1))}>下一步</Button>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

// ---- edit dialog ----

export function EditIfaceDialog({
  nodeId,
  name,
  open,
  onClose,
}: {
  nodeId: number
  name: string
  open: boolean
  onClose: () => void
}) {
  const qc = useQueryClient()
  const [address, setAddress] = React.useState("")
  const [port, setPort] = React.useState("")
  const [dns, setDns] = React.useState("")
  const [mtu, setMtu] = React.useState("")

  const cfg = useQuery({
    queryKey: ["wg", nodeId, "iface", name],
    queryFn: () => wireguardService.getIface(nodeId, name),
    enabled: open && !!name,
  })
  React.useEffect(() => {
    if (!cfg.data) return
    setAddress((cfg.data.address ?? []).join(", "))
    setPort(cfg.data.listen_port ? String(cfg.data.listen_port) : "")
    setDns((cfg.data.dns ?? []).join(", "))
    setMtu(cfg.data.mtu ? String(cfg.data.mtu) : "")
  }, [cfg.data])

  const save = useMutation({
    mutationFn: () =>
      wireguardService.updateIface(nodeId, name, {
        address: splitCSV(address),
        listen_port: port ? Number(port) : 0,
        dns: splitCSV(dns),
        mtu: mtu ? Number(mtu) : 0,
      }),
    onSuccess: () => {
      toast.success("已保存，地址/MTU 变更需「应用配置」生效")
      void qc.invalidateQueries({ queryKey: ["wg", nodeId] })
      onClose()
    },
    onError: onErr,
  })

  return (
    <Dialog open={open} onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle className="text-base font-semibold tracking-tight">编辑接口 {name}</DialogTitle>
        </DialogHeader>
        {cfg.isLoading ? (
          <div className="inline-flex items-center gap-2 py-6 text-xs text-muted-foreground"><Loader2 className="h-3 w-3 animate-spin" /> 读取配置…</div>
        ) : (
          <div className="space-y-2 py-1">
            <Field label="地址 (CIDR，逗号分隔)"><Input value={address} onChange={(e) => setAddress(e.target.value)} className="h-8 font-mono text-xs" /></Field>
            <div className="grid grid-cols-2 gap-2">
              <Field label="监听端口"><Input value={port} onChange={(e) => setPort(e.target.value)} className="h-8 font-mono text-xs" /></Field>
              <Field label="MTU"><Input value={mtu} onChange={(e) => setMtu(e.target.value)} className="h-8 font-mono text-xs" /></Field>
            </div>
            <Field label="DNS (逗号分隔)"><Input value={dns} onChange={(e) => setDns(e.target.value)} className="h-8 font-mono text-xs" /></Field>
          </div>
        )}
        <DialogFooter>
          <Button variant="outline" size="sm" onClick={onClose}>取消</Button>
          <Button size="sm" disabled={save.isPending || cfg.isLoading} onClick={() => save.mutate()}>
            {save.isPending && <Loader2 className="mr-1 h-3 w-3 animate-spin" />} 保存
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

// ---- small form helpers ----

function Field({ label, hint, children }: { label: string; hint?: string; children: React.ReactNode }) {
  return (
    <div className="space-y-1">
      <Label className="text-[11px] text-muted-foreground">{label}</Label>
      {children}
      {hint && <p className="text-[10px] text-muted-foreground/70">{hint}</p>}
    </div>
  )
}

function Toggle({ label, hint, checked, onChange }: { label: string; hint?: string; checked: boolean; onChange: (v: boolean) => void }) {
  return (
    <label className="flex items-center justify-between gap-2 rounded-md border bg-card px-2.5 py-2">
      <span className="min-w-0">
        <span className="block text-xs">{label}</span>
        {hint && <span className="block text-[10px] text-muted-foreground">{hint}</span>}
      </span>
      <Switch checked={checked} onCheckedChange={onChange} />
    </label>
  )
}
