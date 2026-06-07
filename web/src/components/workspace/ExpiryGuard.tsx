"use client"

import * as React from "react"
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog"
import { ApprovalRequestPanel } from "@/components/approvals/ApprovalRequestPanel"
import { useWorkspaceStore } from "@/components/workspace/useWorkspaceStore"
import { arm } from "@/lib/security/x7"

const WARN_MS = 5 * 60_000

// ExpiryGuard wraps a live connection authorised by a time-bound approval grant.
// It does NOT draw over the connection — the countdown is published to the store
// and rendered in the workspace status bar (see WorkspaceStatusBar). On expiry
// it fires onExpire (re-runs the gate → tears the connection down → re-shows the
// request panel). The status bar's "续期" button sets renewTarget for this tab,
// which opens the renewal dialog here; an approval extends the deadline
// (onRenewed → preflight refetch) without dropping the session. Countdown math
// lives in the obfuscated lib/security/x7 core; the server enforces the same
// deadline independently.
export function ExpiryGuard({
  tabId,
  deadline,
  reconcile,
  onExpire,
  onRenewed,
  resourceId,
  title,
  subtitle,
  children,
}: {
  tabId: string
  deadline: string // ISO grant expiry
  reconcile?: () => Promise<number | null>
  onExpire: () => void
  onRenewed: () => void
  resourceId: string
  title: string
  subtitle?: string
  children: React.ReactNode
}) {
  const setExpiry = useWorkspaceStore((s) => s.setExpiry)
  const requestRenew = useWorkspaceStore((s) => s.requestRenew)
  const renewTarget = useWorkspaceStore((s) => s.renewTarget)
  const [renewOpen, setRenewOpen] = React.useState(false)

  const expRef = React.useRef(onExpire)
  const recRef = React.useRef(reconcile)
  React.useEffect(() => {
    expRef.current = onExpire
    recRef.current = reconcile
  })

  React.useEffect(() => {
    const disarm = arm({
      d: Math.max(0, Date.parse(deadline) - Date.now()),
      r: recRef.current ? () => recRef.current!() : undefined,
      t: (v) => setExpiry(tabId, { ms: v, deadline, low: v <= WARN_MS }),
      x: () => expRef.current(),
    })
    return () => {
      disarm()
      setExpiry(tabId, null)
    }
  }, [deadline, tabId, setExpiry])

  // Open the renewal dialog when the status bar requests it for this tab.
  React.useEffect(() => {
    if (renewTarget === tabId) {
      setRenewOpen(true)
      requestRenew(null)
    }
  }, [renewTarget, tabId, requestRenew])

  return (
    <>
      {children}
      <Dialog open={renewOpen} onOpenChange={setRenewOpen}>
        <DialogContent className="max-w-md p-0">
          <DialogHeader className="px-6 pt-6">
            <DialogTitle>续期申请</DialogTitle>
          </DialogHeader>
          {renewOpen && (
            <ApprovalRequestPanel
              className="px-6 pb-6 pt-2"
              resourceId={resourceId}
              title={title}
              subtitle={subtitle}
              onApproved={() => {
                setRenewOpen(false)
                onRenewed()
              }}
            />
          )}
        </DialogContent>
      </Dialog>
    </>
  )
}
