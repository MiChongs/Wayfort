"use client"

import * as React from "react"
import QRCode from "react-qr-code"
import { Download, KeyRound, TriangleAlert } from "lucide-react"
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog"
import { Button } from "@/components/ui/button"
import { CopyButton } from "@/components/common/copy-button"
import type { WGClientConfig } from "@/lib/api/services"
import { downloadText } from "./shared"

/**
 * QrCode renders a scannable QR for the given text. Fixed light background +
 * dark foreground (not coral) so it scans reliably in either theme — a QR is
 * data, not a place for brand voltage.
 */
export function QrCode({ value, size = 180 }: { value: string; size?: number }) {
  return (
    <div className="rounded-lg border bg-[#faf9f5] p-3">
      <QRCode value={value} size={size} bgColor="#faf9f5" fgColor="#181715" level="M" />
    </div>
  )
}

/**
 * ClientConfigDialog shows a freshly generated client config: a scannable QR for
 * the mobile WireGuard app plus the raw .conf with copy/download. The private
 * key only exists here — the warning makes that explicit.
 */
export function ClientConfigDialog({
  open,
  onClose,
  client,
}: {
  open: boolean
  onClose: () => void
  client: WGClientConfig | null
}) {
  const fileName = client ? `${client.interface_name}-client.conf` : "client.conf"
  return (
    <Dialog open={open} onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="max-w-lg">
        <DialogHeader>
          <DialogTitle className="text-base font-semibold tracking-tight">客户端配置已生成</DialogTitle>
          <DialogDescription className="flex items-center gap-1.5 text-warning">
            <TriangleAlert className="h-3.5 w-3.5 shrink-0" />
            私钥仅出现在此配置中，扫码或下载后请妥善保存——关闭后无法再次获取。
          </DialogDescription>
        </DialogHeader>
        {client && (
          <div className="space-y-3">
            <div className="flex flex-col items-start gap-3 sm:flex-row">
              <div className="shrink-0 self-center sm:self-start">
                <QrCode value={client.conf} size={172} />
                <div className="mt-1 text-center text-[10px] text-muted-foreground">手机 WireGuard 扫码导入</div>
              </div>
              <pre className="max-h-[40vh] min-w-0 flex-1 overflow-auto rounded-md border bg-muted/50 p-2 font-mono text-[11px] leading-5">
                {client.conf}
              </pre>
            </div>
            <div className="flex flex-wrap items-center gap-2">
              <CopyButton value={client.conf} label="复制配置" size="sm" variant="outline" />
              <Button variant="outline" size="sm" className="h-7 gap-1 text-xs" onClick={() => downloadText(fileName, client.conf)}>
                <Download className="h-3.5 w-3.5" /> 下载 .conf
              </Button>
              <CopyButton value={client.public_key} label="复制公钥" size="sm" variant="ghost" />
              <span className="ml-auto inline-flex items-center gap-1 text-[10px] text-muted-foreground">
                <KeyRound className="h-3 w-3" /> {client.address}
              </span>
            </div>
          </div>
        )}
      </DialogContent>
    </Dialog>
  )
}
