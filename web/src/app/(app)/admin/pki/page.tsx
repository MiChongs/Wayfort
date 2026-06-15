"use client"

import * as React from "react"
import { useQuery, useQueryClient } from "@tanstack/react-query"
import { ShieldCheck, ShieldX } from "lucide-react"
import { toast } from "@/components/ui/sonner"
import { Button } from "@/components/ui/button"
import { Badge } from "@/components/ui/badge"
import { DataTable, type Column } from "@/components/common/data-table"
import { EmptyState } from "@/components/common/empty-state"
import { confirmDialog } from "@/components/common/confirm-dialog"
import { CopyButton } from "@/components/common/copy-button"
import { pkiService } from "@/lib/api/services"
import type { PKICertStatus, PKICertificate } from "@/lib/api/types"
import { fullTime, relTime } from "@/lib/format"

const CERTS_KEY = ["admin", "pki", "certificates"] as const
const CA_KEY = ["admin", "pki", "ca"] as const

const STATUS_META: Record<PKICertStatus, { label: string; className: string }> = {
  active: { label: "有效", className: "bg-emerald-500/15 text-emerald-700 dark:text-emerald-400" },
  expired: { label: "已过期", className: "bg-muted text-muted-foreground" },
  revoked: { label: "已吊销", className: "bg-destructive/15 text-destructive" },
}

export default function PKIPage() {
  const qc = useQueryClient()
  const ca = useQuery({ queryKey: CA_KEY, queryFn: pkiService.ca })
  const certs = useQuery({ queryKey: CERTS_KEY, queryFn: () => pkiService.certificates() })
  const invalidate = () => qc.invalidateQueries({ queryKey: CERTS_KEY })

  async function onRevoke(cert: PKICertificate) {
    const ok = await confirmDialog({
      title: `吊销证书 ${cert.serial.slice(0, 16)}…？`,
      description: "持有该证书的 Agent 将无法再认证隧道。此操作不可撤销。",
      confirmLabel: "吊销",
      destructive: true,
    })
    if (!ok) return
    try {
      await pkiService.revoke(cert.serial)
      toast.success("证书已吊销")
      invalidate()
    } catch (e) {
      toast.error("吊销失败", { description: (e as Error).message })
    }
  }

  const rows = certs.data?.certificates ?? []

  const columns: Column<PKICertificate & { id: string }>[] = [
    {
      header: "序列号",
      cell: (cert) => (
        <span className="font-mono text-xs text-muted-foreground">{cert.serial.slice(0, 20)}…</span>
      ),
    },
    {
      header: "主体",
      cell: (cert) => (
        <span className="text-sm">
          {cert.subject_kind === "agent" ? "Agent" : cert.subject_kind} #{cert.subject_id}
        </span>
      ),
    },
    {
      header: "指纹",
      cell: (cert) => (
        <span className="font-mono text-xs text-muted-foreground">{cert.fingerprint.slice(0, 16)}…</span>
      ),
    },
    {
      header: "到期",
      cell: (cert) => (
        <span className="text-sm text-muted-foreground" title={fullTime(cert.not_after)}>
          {relTime(cert.not_after)}
        </span>
      ),
    },
    {
      header: "状态",
      cell: (cert) => {
        const meta = STATUS_META[cert.status]
        return (
          <Badge variant="secondary" className={`font-normal ${meta.className}`}>
            {meta.label}
          </Badge>
        )
      },
    },
    {
      header: "操作",
      className: "text-right",
      cell: (cert) =>
        cert.status === "active" ? (
          <Button size="icon-sm" variant="ghost" onClick={() => onRevoke(cert)} aria-label="吊销">
            <ShieldX className="h-4 w-4 text-destructive" />
          </Button>
        ) : (
          <span className="text-xs text-muted-foreground">—</span>
        ),
    },
  ]

  const tableRows = rows.map((r) => ({ ...r, id: r.serial }))
  const showEmpty = !certs.isLoading && rows.length === 0

  return (
    <div className="space-y-6 p-6">
      <div className="space-y-1">
        <h1 className="flex items-center gap-2.5 text-2xl font-semibold tracking-tight">
          <span className="flex h-8 w-8 items-center justify-center rounded-lg bg-primary/12 text-primary">
            <ShieldCheck className="h-5 w-5" />
          </span>
          内部 PKI
        </h1>
        <p className="text-sm text-muted-foreground">
          网关内嵌证书颁发机构：为反连 Agent 签发短时客户端证书（mTLS）。私钥经 KMS 信封加密保管。
        </p>
      </div>

      {/* CA info card */}
      {ca.data && (
        <div className="rounded-lg border bg-muted/30 p-4">
          <div className="flex flex-wrap items-start justify-between gap-3">
            <div className="space-y-1">
              <div className="text-sm font-medium">{ca.data.subject}</div>
              <div className="text-xs text-muted-foreground">
                模式 {ca.data.mode} · 有效期至{" "}
                <span title={fullTime(ca.data.not_after)}>{relTime(ca.data.not_after)}</span>
              </div>
            </div>
            <CopyButton value={ca.data.bundle} label="复制 CA 根证书" size="sm" variant="outline" />
          </div>
        </div>
      )}

      {!showEmpty && (
        <DataTable columns={columns} rows={tableRows} loading={certs.isLoading} virtualize />
      )}

      {showEmpty && (
        <EmptyState
          icon={ShieldCheck}
          title="还没有签发任何证书"
          description="当 Agent 注册接入时，其客户端证书会出现在这里。"
        />
      )}
    </div>
  )
}
