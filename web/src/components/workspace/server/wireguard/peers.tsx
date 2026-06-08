"use client"

import * as React from "react"
import { useMutation, useQueryClient } from "@tanstack/react-query"
import { Loader2, Pencil, Plus, Trash2, UserPlus } from "lucide-react"
import { toast } from "@/components/ui/sonner"
import { Button } from "@/components/ui/button"
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
import { VirtualTable } from "@/components/common/virtual-table"
import { useConfirm } from "@/components/admin/use-confirm"
import {
  wireguardService,
  type WGClientConfig,
  type WGIface,
  type WGPeer,
  type WGPeerReq,
} from "@/lib/api/services"
import { cn } from "@/lib/utils"
import { codeOf, RunInTerminalButton, type ApiError } from "../_shared"
import { ClientConfigDialog } from "./qr"
import { errorHint, fmtBytes, HandshakeBadge, SectionHeader, WgEmpty } from "./shared"

function onErr(e: ApiError) {
  toast.error("操作失败", { description: errorHint(codeOf(e), e?.message || "") || e?.message })
}

export function PeersView({
  nodeId,
  tabId,
  ifaces,
  initialIface,
}: {
  nodeId: number
  tabId: string
  ifaces: WGIface[]
  initialIface?: string
}) {
  const qc = useQueryClient()
  const { confirm, dialog } = useConfirm()
  const [sel, setSel] = React.useState(initialIface ?? ifaces[0]?.name ?? "")
  const [filter, setFilter] = React.useState("")
  const [addOpen, setAddOpen] = React.useState(false)
  const [clientOpen, setClientOpen] = React.useState(false)
  const [editPeer, setEditPeer] = React.useState<WGPeer | null>(null)
  const [client, setClient] = React.useState<WGClientConfig | null>(null)

  React.useEffect(() => {
    if (initialIface) setSel(initialIface)
  }, [initialIface])
  React.useEffect(() => {
    if (!ifaces.find((i) => i.name === sel) && ifaces[0]) setSel(ifaces[0].name)
  }, [ifaces, sel])

  const iface = ifaces.find((i) => i.name === sel)
  const peers = (iface?.peers ?? []).filter((p) => {
    if (!filter.trim()) return true
    const q = filter.toLowerCase()
    return p.public_key.toLowerCase().includes(q) || (p.allowed_ips ?? []).some((a) => a.toLowerCase().includes(q))
  })

  const del = useMutation({
    mutationFn: (pub: string) => wireguardService.deletePeer(nodeId, sel, pub),
    onSuccess: () => {
      toast.success("对端已移除")
      void qc.invalidateQueries({ queryKey: ["wg", nodeId] })
    },
    onError: onErr,
  })

  const onDelete = async (p: WGPeer) => {
    const ok = await confirm({
      title: "移除对端？",
      description: "移除后该对端的隧道将断开。",
      confirmLabel: "移除",
    })
    if (ok) del.mutate(p.public_key)
  }

  if (ifaces.length === 0) {
    return <WgEmpty title="暂无接口" sub="先在「接口」页创建一个 WireGuard 接口。" />
  }

  return (
    <div className="flex h-full min-h-0 flex-col">
      {dialog}
      <SectionHeader title="对端" count={`${peers.length}`}>
        <Button size="sm" variant="outline" className="h-7 gap-1 text-xs" onClick={() => setAddOpen(true)}>
          <Plus className="h-3.5 w-3.5" /> 新增对端
        </Button>
        <Button size="sm" className="h-7 gap-1 text-xs" onClick={() => setClientOpen(true)}>
          <UserPlus className="h-3.5 w-3.5" /> 生成客户端
        </Button>
      </SectionHeader>

      <div className="flex items-center gap-2 border-b bg-card/60 px-3 py-1.5">
        <Select value={sel} onValueChange={setSel}>
          <SelectTrigger className="h-7 w-32 text-xs"><SelectValue /></SelectTrigger>
          <SelectContent>
            {ifaces.map((i) => (
              <SelectItem key={i.name} value={i.name} className="font-mono text-xs">{i.name}</SelectItem>
            ))}
          </SelectContent>
        </Select>
        <Input value={filter} onChange={(e) => setFilter(e.target.value)} placeholder="过滤 公钥 / IP" className="h-7 flex-1 text-xs" />
      </div>

      <div className="min-h-0 flex-1">
        <VirtualTable<WGPeer>
          rows={peers}
          empty="无对端"
          header={
            <>
              <th className="px-2 py-1.5 text-left">对端</th>
              <th className="px-2 py-1.5 text-left">端点</th>
              <th className="px-2 py-1.5 text-right">握手</th>
              <th className="px-2 py-1.5 text-right">↓ / ↑</th>
              <th className="px-2 py-1.5 text-right">操作</th>
            </>
          }
          renderRow={(p) => {
            const ips = p.allowed_ips ?? []
            return (
              <>
                <td className="max-w-[8rem] truncate px-2 py-1 font-mono text-[10px]" title={p.public_key}>
                  {p.public_key.slice(0, 12)}…
                  {ips.length > 0 && (
                    <div className="truncate text-[9px] text-muted-foreground" title={ips.join(", ")}>{ips.join(", ")}</div>
                  )}
                </td>
                <td className="max-w-[8rem] truncate px-2 py-1 font-mono text-[10px] text-muted-foreground" title={p.endpoint}>{p.endpoint || "—"}</td>
                <td className="whitespace-nowrap px-2 py-1 text-right text-[10px]"><HandshakeBadge ts={p.latest_handshake} /></td>
                <td className="whitespace-nowrap px-2 py-1 text-right font-mono text-[10px] text-muted-foreground">{fmtBytes(p.transfer_rx)} / {fmtBytes(p.transfer_tx)}</td>
                <td className="whitespace-nowrap px-1 py-0.5 text-right">
                  <div className="inline-flex items-center gap-0.5">
                    <Button variant="ghost" size="icon" className="h-6 w-6" title="编辑" onClick={() => setEditPeer(p)}><Pencil className="h-3 w-3" /></Button>
                    <RunInTerminalButton tabId={tabId} command={`wg show ${sel} | sed -n '/${p.public_key.slice(0, 8)}/,+4p'`} run={false} label="终端查看" />
                    <Button variant="ghost" size="icon" className="h-6 w-6 text-destructive" title="移除" onClick={() => onDelete(p)}><Trash2 className="h-3 w-3" /></Button>
                  </div>
                </td>
              </>
            )
          }}
        />
      </div>

      <PeerWizard nodeId={nodeId} iface={sel} open={addOpen} onClose={() => setAddOpen(false)} />
      <ClientWizard
        nodeId={nodeId}
        iface={sel}
        open={clientOpen}
        onClose={() => setClientOpen(false)}
        onGenerated={(c) => {
          setClient(c)
          setClientOpen(false)
        }}
      />
      {editPeer && (
        <EditPeerDialog nodeId={nodeId} iface={sel} peer={editPeer} open onClose={() => setEditPeer(null)} />
      )}
      <ClientConfigDialog open={!!client} onClose={() => setClient(null)} client={client} />
    </div>
  )
}

// ---- add peer (advanced: peer manages its own key) ----

function PeerWizard({ nodeId, iface, open, onClose }: { nodeId: number; iface: string; open: boolean; onClose: () => void }) {
  const qc = useQueryClient()
  const [pub, setPub] = React.useState("")
  const [allowed, setAllowed] = React.useState("")
  const [endpoint, setEndpoint] = React.useState("")
  const [keepalive, setKeepalive] = React.useState("25")
  const [comment, setComment] = React.useState("")

  React.useEffect(() => {
    if (!open) return
    setPub("")
    setAllowed("")
    setEndpoint("")
    setKeepalive("25")
    setComment("")
  }, [open])

  const add = useMutation({
    mutationFn: () => {
      const body: WGPeerReq = {
        public_key: pub.trim(),
        allowed_ips: allowed.split(",").map((x) => x.trim()).filter(Boolean),
        endpoint: endpoint.trim() || undefined,
        persistent_keepalive: keepalive ? Number(keepalive) : undefined,
        comment: comment.trim() || undefined,
      }
      return wireguardService.addPeer(nodeId, iface, body)
    },
    onSuccess: () => {
      toast.success("对端已添加")
      void qc.invalidateQueries({ queryKey: ["wg", nodeId] })
      onClose()
    },
    onError: onErr,
  })

  return (
    <Dialog open={open} onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle className="text-base font-semibold tracking-tight">新增对端 · {iface}</DialogTitle>
          <DialogDescription>粘贴对端公钥（对端自行保管私钥）。如需我们生成完整客户端配置，请用「生成客户端」。</DialogDescription>
        </DialogHeader>
        <div className="space-y-2 py-1">
          <PField label="对端公钥"><Input value={pub} onChange={(e) => setPub(e.target.value)} placeholder="base64 公钥" className="h-8 font-mono text-[11px]" /></PField>
          <PField label="AllowedIPs (逗号分隔)" hint="允许该对端使用的隧道地址，如 10.8.0.2/32"><Input value={allowed} onChange={(e) => setAllowed(e.target.value)} placeholder="10.8.0.2/32" className="h-8 font-mono text-xs" /></PField>
          <div className="grid grid-cols-2 gap-2">
            <PField label="Endpoint (可选)"><Input value={endpoint} onChange={(e) => setEndpoint(e.target.value)} placeholder="host:port" className="h-8 font-mono text-xs" /></PField>
            <PField label="Keepalive (秒)"><Input value={keepalive} onChange={(e) => setKeepalive(e.target.value)} className="h-8 font-mono text-xs" /></PField>
          </div>
          <PField label="备注 (可选)"><Input value={comment} onChange={(e) => setComment(e.target.value)} placeholder="如 office-laptop" className="h-8 text-xs" /></PField>
        </div>
        <DialogFooter>
          <Button variant="outline" size="sm" onClick={onClose}>取消</Button>
          <Button size="sm" disabled={add.isPending || !pub.trim() || !allowed.trim()} onClick={() => add.mutate()}>
            {add.isPending && <Loader2 className="mr-1 h-3 w-3 animate-spin" />} 添加
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

// ---- generate client (one-click: server generates keys + IP + config) ----

function ClientWizard({
  nodeId,
  iface,
  open,
  onClose,
  onGenerated,
}: {
  nodeId: number
  iface: string
  open: boolean
  onClose: () => void
  onGenerated: (c: WGClientConfig) => void
}) {
  const qc = useQueryClient()
  const [comment, setComment] = React.useState("")
  const [endpoint, setEndpoint] = React.useState("")
  const [fullTunnel, setFullTunnel] = React.useState(true)
  const [splitIps, setSplitIps] = React.useState("")
  const [usePsk, setUsePsk] = React.useState(true)

  React.useEffect(() => {
    if (!open) return
    setComment("")
    setEndpoint("")
    setFullTunnel(true)
    setSplitIps("")
    setUsePsk(true)
  }, [open])

  const gen = useMutation({
    mutationFn: () =>
      wireguardService.newClient(nodeId, iface, {
        comment: comment.trim() || undefined,
        endpoint: endpoint.trim() || undefined,
        use_psk: usePsk,
        allowed_ips: fullTunnel ? undefined : splitIps.split(",").map((x) => x.trim()).filter(Boolean),
      }),
    onSuccess: (c) => {
      toast.success("客户端已生成并加入对端")
      void qc.invalidateQueries({ queryKey: ["wg", nodeId] })
      onGenerated(c)
    },
    onError: onErr,
  })

  return (
    <Dialog open={open} onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle className="text-base font-semibold tracking-tight">生成客户端 · {iface}</DialogTitle>
          <DialogDescription>自动分配子网内的下一个可用 IP、生成密钥对，并返回可扫码导入的配置。</DialogDescription>
        </DialogHeader>
        <div className="space-y-2.5 py-1">
          <PField label="设备名 / 备注 (可选)"><Input value={comment} onChange={(e) => setComment(e.target.value)} placeholder="如 my-phone" className="h-8 text-xs" /></PField>
          <PField label="公网 Endpoint (可选)" hint="客户端用于连接本机的公网地址/域名；留空则用节点主机地址"><Input value={endpoint} onChange={(e) => setEndpoint(e.target.value)} placeholder="vpn.example.com" className="h-8 font-mono text-xs" /></PField>
          <label className="flex items-center justify-between gap-2 rounded-md border bg-card px-2.5 py-2">
            <span className="text-xs">全局路由 (0.0.0.0/0, ::/0)</span>
            <Switch checked={fullTunnel} onCheckedChange={setFullTunnel} />
          </label>
          {!fullTunnel && (
            <PField label="分流 AllowedIPs (逗号分隔)"><Input value={splitIps} onChange={(e) => setSplitIps(e.target.value)} placeholder="10.8.0.0/24, 192.168.1.0/24" className="h-8 font-mono text-xs" /></PField>
          )}
          <label className="flex items-center justify-between gap-2 rounded-md border bg-card px-2.5 py-2">
            <span className="text-xs">使用预共享密钥 (PSK，更强)</span>
            <Switch checked={usePsk} onCheckedChange={setUsePsk} />
          </label>
        </div>
        <DialogFooter>
          <Button variant="outline" size="sm" onClick={onClose}>取消</Button>
          <Button size="sm" disabled={gen.isPending} onClick={() => gen.mutate()}>
            {gen.isPending && <Loader2 className="mr-1 h-3 w-3 animate-spin" />} 生成
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

// ---- edit peer ----

function EditPeerDialog({
  nodeId,
  iface,
  peer,
  open,
  onClose,
}: {
  nodeId: number
  iface: string
  peer: WGPeer
  open: boolean
  onClose: () => void
}) {
  const qc = useQueryClient()
  const [allowed, setAllowed] = React.useState((peer.allowed_ips ?? []).join(", "))
  const [endpoint, setEndpoint] = React.useState(peer.endpoint || "")
  const [keepalive, setKeepalive] = React.useState(peer.keepalive ? String(parseInt(peer.keepalive)) || "" : "")

  const save = useMutation({
    mutationFn: () =>
      wireguardService.updatePeer(nodeId, iface, {
        public_key: peer.public_key,
        allowed_ips: allowed.split(",").map((x) => x.trim()).filter(Boolean),
        endpoint: endpoint.trim() || undefined,
        persistent_keepalive: keepalive ? Number(keepalive) : undefined,
      }),
    onSuccess: () => {
      toast.success("对端已更新")
      void qc.invalidateQueries({ queryKey: ["wg", nodeId] })
      onClose()
    },
    onError: onErr,
  })

  return (
    <Dialog open={open} onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle className="text-base font-semibold tracking-tight">编辑对端</DialogTitle>
          <DialogDescription className="truncate font-mono text-[11px]" title={peer.public_key}>{peer.public_key}</DialogDescription>
        </DialogHeader>
        <div className="space-y-2 py-1">
          <PField label="AllowedIPs (逗号分隔)"><Input value={allowed} onChange={(e) => setAllowed(e.target.value)} className="h-8 font-mono text-xs" /></PField>
          <div className="grid grid-cols-2 gap-2">
            <PField label="Endpoint"><Input value={endpoint} onChange={(e) => setEndpoint(e.target.value)} placeholder="host:port" className="h-8 font-mono text-xs" /></PField>
            <PField label="Keepalive (秒)"><Input value={keepalive} onChange={(e) => setKeepalive(e.target.value)} className="h-8 font-mono text-xs" /></PField>
          </div>
        </div>
        <DialogFooter>
          <Button variant="outline" size="sm" onClick={onClose}>取消</Button>
          <Button size="sm" disabled={save.isPending || !allowed.trim()} onClick={() => save.mutate()}>
            {save.isPending && <Loader2 className="mr-1 h-3 w-3 animate-spin" />} 保存
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

function PField({ label, hint, children }: { label: string; hint?: string; children: React.ReactNode }) {
  return (
    <div className={cn("space-y-1")}>
      <Label className="text-[11px] text-muted-foreground">{label}</Label>
      {children}
      {hint && <p className="text-[10px] text-muted-foreground/70">{hint}</p>}
    </div>
  )
}
