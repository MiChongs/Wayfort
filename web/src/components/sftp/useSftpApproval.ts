"use client"

import * as React from "react"
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query"
import { approvalService } from "@/lib/api/services"
import { useApprovalStream } from "@/lib/hooks/use-approval-stream"

// Session-level write-authorization state machine for a node's SFTP surface.
//
// Browsing (read) is always allowed. Mutating operations — upload, delete,
// rename, chmod, mkdir, write, copy — and downloads are gated behind a single
// time-bound file_transfer grant whenever the node carries the
// RequiresApprovalForFileXfer flag. The backend issues one grant covering both
// `sftp_read` and `sftp_write`, so one approval unlocks the whole surface for
// its window.
//
//   checking ─▶ open        node doesn't require approval — everything allowed
//            └▶ locked ─▶ (apply) ─▶ pending ─▶ granted ─▶ (expiry) ─▶ locked
//
// The hook owns the preflight query and any in-flight request id; the header
// bar and the request sheet read off its compact surface.
export type SftpWriteMode = "checking" | "open" | "locked" | "pending" | "granted"

export function useSftpApproval(nodeId: number) {
  const qc = useQueryClient()
  const [requestId, setRequestId] = React.useState<string | undefined>(undefined)

  const key = React.useMemo(() => ["sftp-approval", nodeId] as const, [nodeId])

  const preflight = useQuery({
    queryKey: key,
    queryFn: () =>
      approvalService.preflight({
        resource_id: String(nodeId),
        business_type: "file_transfer",
        action: "sftp_write",
      }),
    enabled: Number.isFinite(nodeId),
    staleTime: 0,
    refetchOnWindowFocus: true,
  })

  // Adopt a server-known pending request so a page refresh resumes the wait
  // rather than offering a duplicate apply form.
  React.useEffect(() => {
    const pid = preflight.data?.pending_request_id
    if (pid && !requestId) setRequestId(pid)
  }, [preflight.data?.pending_request_id, requestId])

  // Live-follow the in-flight request; on a terminal-approved transition,
  // re-run preflight so the machine settles into `granted`.
  const stream = useApprovalStream(requestId)
  const streamStatus = stream.data?.request.status
  React.useEffect(() => {
    if (!requestId) return
    if (streamStatus === "approved" || streamStatus === "auto_approved") {
      void qc.invalidateQueries({ queryKey: key })
    }
  }, [streamStatus, requestId, key, qc])

  const required = preflight.data?.required ?? false
  const allowed = preflight.data?.allowed ?? false

  // Once preflight confirms the grant landed, drop the request id so we stop
  // streaming a now-settled request.
  React.useEffect(() => {
    if (allowed && requestId && (streamStatus === "approved" || streamStatus === "auto_approved")) {
      setRequestId(undefined)
    }
  }, [allowed, requestId, streamStatus])

  let mode: SftpWriteMode = "checking"
  if (preflight.isLoading && !preflight.data) mode = "checking"
  else if (!required) mode = "open"
  else if (allowed) mode = "granted"
  else if (requestId && streamStatus === "pending") mode = "pending"
  else mode = "locked"

  const apply = useMutation({
    mutationFn: (vars: { reason: string; durationSec: number }) =>
      approvalService.create({
        business_type: "file_transfer",
        title: "SFTP 写入授权",
        reason: vars.reason.trim(),
        resource_type: "node",
        resource_id: String(nodeId),
        payload: { action: "sftp_write" },
        window_end: new Date(Date.now() + vars.durationSec * 1000).toISOString(),
      }),
    onSuccess: (out) => {
      if (out.auto_approved) {
        void qc.invalidateQueries({ queryKey: key })
        return
      }
      setRequestId(out.request.id)
    },
  })

  const cancelRequest = useMutation({
    mutationFn: () => approvalService.cancel(requestId!, "用户撤销"),
    onSuccess: () => {
      setRequestId(undefined)
      void qc.invalidateQueries({ queryKey: key })
    },
  })

  return {
    mode,
    required,
    canWrite: mode === "open" || mode === "granted",
    expiresAt: preflight.data?.expires_at,
    grantId: preflight.data?.grant_id,
    requestId,
    stream,
    apply,
    cancelRequest,
    reapply: () => setRequestId(undefined),
    refresh: () => qc.invalidateQueries({ queryKey: key }),
  }
}

export type SftpApproval = ReturnType<typeof useSftpApproval>
