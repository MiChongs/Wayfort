"use client"

import * as React from "react"
import { useQuery, useQueryClient } from "@tanstack/react-query"
import { streamSSE } from "@/lib/sse/eventsource"
import { approvalService } from "@/lib/api/services"

// useApprovalStream keeps one approval request live: a react-query poll (slow
// fallback) plus an SSE subscription that invalidates on every transition for
// instant updates. Auto-reconnects with a fixed backoff on stream drop.
export function useApprovalStream(requestId: string | undefined) {
  const qc = useQueryClient()
  const query = useQuery({
    queryKey: ["approval", requestId],
    enabled: !!requestId,
    queryFn: () => approvalService.get(requestId!),
    refetchInterval: requestId ? 8000 : false,
  })

  React.useEffect(() => {
    if (!requestId) return
    const ctrl = new AbortController()
    let active = true
    const run = async () => {
      while (active) {
        try {
          await streamSSE(approvalService.requestStreamURL(requestId), { signal: ctrl.signal }, (kind) => {
            if (kind === "update" || kind === "snapshot") {
              qc.invalidateQueries({ queryKey: ["approval", requestId] })
            }
          })
        } catch {
          /* network blip — fall through to backoff + reconnect */
        }
        if (!active) break
        await new Promise((r) => setTimeout(r, 3000))
      }
    }
    void run()
    return () => {
      active = false
      ctrl.abort()
    }
  }, [requestId, qc])

  return query
}
