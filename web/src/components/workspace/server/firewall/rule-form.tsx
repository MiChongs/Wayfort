"use client"

import * as React from "react"
import { useQuery } from "@tanstack/react-query"
import { Loader2 } from "lucide-react"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog"
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select"
import { firewallService } from "@/lib/api/services"
import type { FirewallRuleSpec } from "@/lib/api/types"
import { cn } from "@/lib/utils"

type Mode = "add" | "edit"

export function RuleFormDialog({
  open,
  onClose,
  nodeId,
  mode,
  initial,
  busy,
  onSubmit,
}: {
  open: boolean
  onClose: () => void
  nodeId: number
  mode: Mode
  initial?: Partial<FirewallRuleSpec>
  busy?: boolean
  onSubmit: (spec: FirewallRuleSpec) => void
}) {
  const [action, setAction] = React.useState<FirewallRuleSpec["action"]>("ALLOW")
  const [direction, setDirection] = React.useState<"in" | "out">("in")
  const [protocol, setProtocol] = React.useState<NonNullable<FirewallRuleSpec["protocol"]>>("tcp")
  const [port, setPort] = React.useState("")
  const [source, setSource] = React.useState("")
  const [comment, setComment] = React.useState("")

  React.useEffect(() => {
    if (!open) return
    setAction((initial?.action as FirewallRuleSpec["action"]) ?? "ALLOW")
    setDirection((initial?.direction as "in" | "out") ?? "in")
    setProtocol((initial?.protocol as NonNullable<FirewallRuleSpec["protocol"]>) ?? "tcp")
    setPort(initial?.port ?? "")
    setSource(initial?.source ?? "")
    setComment(initial?.comment ?? "")
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open])

  const submit = () =>
    onSubmit({
      action,
      direction,
      protocol,
      port: port.trim(),
      source: source.trim() || undefined,
      comment: comment.trim() || undefined,
    })

  const valid = protocol === "icmp" || protocol === "any" || port.trim() !== ""

  return (
    <Dialog open={open} onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="max-w-lg">
        <DialogHeader>
          <DialogTitle className="text-base font-semibold tracking-tight">
            {mode === "edit" ? "编辑规则" : "添加规则"}
          </DialogTitle>
          <DialogDescription>点服务预设可一键填充端口，也可手动输入单个/列表(80,443)/范围(8000:9000)。</DialogDescription>
        </DialogHeader>

        <PresetPicker
          nodeId={nodeId}
          activePort={port}
          onPick={(p, proto) => {
            setPort(p)
            if (proto === "tcp" || proto === "udp") setProtocol(proto)
          }}
        />

        <div className="grid grid-cols-2 gap-2 py-1">
          <Field label="动作">
            <Select value={action} onValueChange={(v) => setAction(v as FirewallRuleSpec["action"])}>
              <SelectTrigger className="h-8 text-xs"><SelectValue /></SelectTrigger>
              <SelectContent>
                <SelectItem value="ALLOW">允许 (ALLOW)</SelectItem>
                <SelectItem value="DENY">拒绝 (DENY)</SelectItem>
                <SelectItem value="REJECT">拒绝并回包 (REJECT)</SelectItem>
              </SelectContent>
            </Select>
          </Field>
          <Field label="方向">
            <Select value={direction} onValueChange={(v) => setDirection(v as "in" | "out")}>
              <SelectTrigger className="h-8 text-xs"><SelectValue /></SelectTrigger>
              <SelectContent>
                <SelectItem value="in">入站 (in)</SelectItem>
                <SelectItem value="out">出站 (out)</SelectItem>
              </SelectContent>
            </Select>
          </Field>
          <Field label="协议">
            <Select value={protocol} onValueChange={(v) => setProtocol(v as NonNullable<FirewallRuleSpec["protocol"]>)}>
              <SelectTrigger className="h-8 text-xs"><SelectValue /></SelectTrigger>
              <SelectContent>
                <SelectItem value="tcp">TCP</SelectItem>
                <SelectItem value="udp">UDP</SelectItem>
                <SelectItem value="icmp">ICMP</SelectItem>
                <SelectItem value="any">Any</SelectItem>
              </SelectContent>
            </Select>
          </Field>
          <Field label="端口">
            <Input value={port} onChange={(e) => setPort(e.target.value)} placeholder="22 / 80,443 / 8000:9000" className="h-8 font-mono text-xs" disabled={protocol === "icmp" || protocol === "any"} />
          </Field>
          <Field label="来源 CIDR (空=任意)" className="col-span-2">
            <Input value={source} onChange={(e) => setSource(e.target.value)} placeholder="10.0.0.0/8 / 1.2.3.4" className="h-8 font-mono text-xs" />
          </Field>
          <Field label="备注 (可选)" className="col-span-2">
            <Input value={comment} onChange={(e) => setComment(e.target.value)} placeholder="如 office-vpn" className="h-8 text-xs" />
          </Field>
        </div>

        <DialogFooter>
          <Button variant="outline" size="sm" onClick={onClose}>取消</Button>
          <Button size="sm" disabled={!valid || busy} onClick={submit}>
            {busy && <Loader2 className="mr-1 h-3 w-3 animate-spin" />} {mode === "edit" ? "保存" : "添加"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

function PresetPicker({
  nodeId,
  activePort,
  onPick,
}: {
  nodeId: number
  activePort: string
  onPick: (port: string, proto: string) => void
}) {
  const presets = useQuery({
    queryKey: ["fw", nodeId, "presets"],
    queryFn: () => firewallService.presets(nodeId),
    staleTime: 5 * 60_000,
  })
  const items = presets.data?.presets ?? []
  if (items.length === 0) return null
  return (
    <div className="flex flex-wrap gap-1">
      {items.map((p) => {
        const on = activePort === p.port
        return (
          <button
            key={p.id}
            type="button"
            onClick={() => onPick(p.port, p.protocol)}
            className={cn(
              "shrink-0 whitespace-nowrap rounded-full border px-2 py-0.5 text-[10px] transition-colors",
              on ? "border-primary/40 bg-primary/[0.08] text-foreground" : "border-border text-muted-foreground hover:bg-accent/50",
            )}
            title={`${p.name} · ${p.port}/${p.protocol}`}
          >
            {p.name} <span className="font-mono text-muted-foreground">{p.port}</span>
          </button>
        )
      })}
    </div>
  )
}

function Field({ label, className, children }: { label: string; className?: string; children: React.ReactNode }) {
  return (
    <div className={cn("space-y-1", className)}>
      <Label className="text-[11px] text-muted-foreground">{label}</Label>
      {children}
    </div>
  )
}
