"use client"

import * as React from "react"
import { Loader2 } from "lucide-react"
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog"
import { Button } from "@/components/ui/button"

// Imperative confirm dialog — replaces native window.confirm with proper UX
// (Tailwind/shadcn styling, async loading state, configurable destructive variant).
type Resolver = (ok: boolean) => void

type ConfirmRequest = {
  title: string
  description?: React.ReactNode
  confirmLabel?: string
  cancelLabel?: string
  destructive?: boolean
  resolve: Resolver
}

let setReq: React.Dispatch<React.SetStateAction<ConfirmRequest | null>> | null = null

export function confirmDialog(opts: Omit<ConfirmRequest, "resolve">): Promise<boolean> {
  return new Promise((resolve) => {
    if (!setReq) { resolve(false); return }
    setReq({ ...opts, resolve })
  })
}

export function ConfirmDialogHost() {
  const [req, setReqState] = React.useState<ConfirmRequest | null>(null)
  const [busy, setBusy] = React.useState(false)
  React.useEffect(() => { setReq = setReqState; return () => { setReq = null } }, [])
  function close(ok: boolean) {
    if (req) req.resolve(ok)
    setReqState(null)
    setBusy(false)
  }
  return (
    <Dialog open={!!req} onOpenChange={(o) => !o && close(false)}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{req?.title}</DialogTitle>
          {req?.description && <DialogDescription>{req.description}</DialogDescription>}
        </DialogHeader>
        <DialogFooter>
          <Button variant="outline" onClick={() => close(false)} disabled={busy}>
            {req?.cancelLabel || "取消"}
          </Button>
          <Button
            variant={req?.destructive ? "destructive" : "default"}
            onClick={() => { setBusy(true); close(true) }}
            disabled={busy}
          >
            {busy && <Loader2 className="w-4 h-4 animate-spin" />}
            {req?.confirmLabel || "确认"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
