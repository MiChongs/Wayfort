"use client"

import * as React from "react"
import { useQuery, useQueryClient } from "@tanstack/react-query"
import { Loader2 } from "lucide-react"
import { ApprovalRequestPanel } from "@/components/approvals/ApprovalRequestPanel"
import { ExpiryGuard } from "@/components/workspace/ExpiryGuard"
import { approvalService } from "@/lib/api/services"

export type GateState = "checking" | "approval" | "allowed"

// ApprovalGate sits in front of a connect-gated protocol. It runs the approval
// preflight; if the asset needs approval and the user has no active grant it
// renders the request panel (apply + live status) instead of letting the
// connection open and immediately close. On approval it re-checks and renders
// the real connection, which auto-connects on mount.
export function ApprovalGate({
  tabId,
  nodeId,
  nodeName,
  nodeSubtitle,
  countdown = true,
  onStateChange,
  children,
}: {
  tabId: string
  nodeId: number
  nodeName: string
  nodeSubtitle?: string
  /** Publish the expiry countdown + enable renewal (live sessions only). */
  countdown?: boolean
  onStateChange?: (s: GateState) => void
  children: React.ReactNode
}) {
  const qc = useQueryClient()
  const q = useQuery({
    queryKey: ["approval-preflight", nodeId],
    queryFn: () => approvalService.preflight({ resource_id: String(nodeId) }),
    staleTime: 0,
    refetchOnWindowFocus: false,
  })

  const blocked = !!q.data && q.data.required && !q.data.allowed
  const state: GateState = q.isLoading ? "checking" : blocked ? "approval" : "allowed"

  // Keep the latest callback in a ref so the notify effect depends ONLY on
  // `state` — depending on the (inline, re-created every render) callback would
  // re-run on every render and, via setStatus, loop infinitely.
  const cbRef = React.useRef(onStateChange)
  React.useEffect(() => {
    cbRef.current = onStateChange
  })
  React.useEffect(() => {
    cbRef.current?.(state)
  }, [state])

  if (q.isLoading) {
    return (
      <div className="grid h-full place-items-center text-sm text-muted-foreground">
        <span className="flex items-center gap-2">
          <Loader2 className="h-4 w-4 animate-spin" /> 正在检查访问权限…
        </span>
      </div>
    )
  }

  // Preflight failed (e.g. approval service unavailable): defer to the gateway,
  // which is the final authority and will block at connect time if needed.
  if (q.isError || !q.data) {
    return <>{children}</>
  }

  if (blocked) {
    return (
      <div className="h-full overflow-y-auto">
        <ApprovalRequestPanel
          resourceId={String(nodeId)}
          title={nodeName}
          subtitle={nodeSubtitle}
          existingRequestId={q.data.pending_request_id}
          onApproved={() => qc.invalidateQueries({ queryKey: ["approval-preflight", nodeId] })}
        />
      </div>
    )
  }

  // Time-bound grant: wrap the live connection in the expiry guard (countdown +
  // auto teardown on expiry). The server enforces the same deadline.
  if (countdown && q.data.expires_at) {
    const refresh = () => qc.invalidateQueries({ queryKey: ["approval-preflight", nodeId] })
    return (
      <ExpiryGuard
        tabId={tabId}
        deadline={q.data.expires_at}
        resourceId={String(nodeId)}
        title={nodeName}
        subtitle={nodeSubtitle}
        reconcile={async () => {
          const p = await approvalService.preflight({ resource_id: String(nodeId) })
          if (!p.allowed) return null
          return p.expires_at ? Date.parse(p.expires_at) - Date.now() : Number.MAX_SAFE_INTEGER
        }}
        onExpire={refresh}
        onRenewed={refresh}
      >
        {children}
      </ExpiryGuard>
    )
  }

  return <>{children}</>
}
