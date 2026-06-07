"use client"

import * as React from "react"
import { toast } from "@/components/ui/sonner"
import { streamSSE } from "@/lib/sse/eventsource"
import { approvalService } from "@/lib/api/services"
import { useCurrentUser } from "@/lib/hooks/use-current-user"
import type { AppNotification, ApprovalStreamEvent } from "@/lib/api/types"

// NotificationContext is the in-app notification surface. Today its only source
// is the approval event stream; the shape (AppNotification) and the push() API
// are deliberately generic so future sources (sessions, system alerts, …) plug
// in without touching consumers.
type Ctx = {
  notifications: AppNotification[]
  unreadCount: number
  markAllRead: () => void
  markRead: (id: string) => void
  clear: () => void
  push: (n: AppNotification) => void
}

const NotificationContext = React.createContext<Ctx | null>(null)

export function useNotifications(): Ctx {
  const ctx = React.useContext(NotificationContext)
  if (!ctx) throw new Error("useNotifications must be used within NotificationProvider")
  return ctx
}

const MAX = 50

export function NotificationProvider({ children }: { children: React.ReactNode }) {
  const [items, setItems] = React.useState<AppNotification[]>([])
  const claims = useCurrentUser()
  const myId = claims?.uid

  const push = React.useCallback((n: AppNotification) => {
    setItems((prev) => {
      if (prev.some((x) => x.id === n.id)) return prev
      return [n, ...prev].slice(0, MAX)
    })
  }, [])

  const markAllRead = React.useCallback(() => setItems((prev) => prev.map((n) => ({ ...n, read: true }))), [])
  const markRead = React.useCallback(
    (id: string) => setItems((prev) => prev.map((n) => (n.id === id ? { ...n, read: true } : n))),
    [],
  )
  const clear = React.useCallback(() => setItems([]), [])

  // Subscribe to the per-user approval event stream. Reconnects with backoff.
  React.useEffect(() => {
    if (myId == null) return
    const ctrl = new AbortController()
    let active = true
    const run = async () => {
      while (active) {
        try {
          await streamSSE(approvalService.userStreamURL(), { signal: ctrl.signal }, (kind, data) => {
            if (kind !== "update" && kind !== "snapshot") return
            const ev = data as ApprovalStreamEvent
            const n = toNotification(ev, myId)
            if (!n) return
            push(n)
            emitToast(n)
          })
        } catch {
          /* network blip — backoff + reconnect */
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
  }, [myId, push])

  const value = React.useMemo<Ctx>(
    () => ({
      notifications: items,
      unreadCount: items.filter((n) => !n.read).length,
      markAllRead,
      markRead,
      clear,
      push,
    }),
    [items, markAllRead, markRead, clear, push],
  )

  return <NotificationContext.Provider value={value}>{children}</NotificationContext.Provider>
}

// toNotification maps an approval stream event into a notification, or null when
// the event isn't worth surfacing (internal transitions, own pending request).
function toNotification(ev: ApprovalStreamEvent, myId: number): AppNotification | null {
  const base = {
    id: `${ev.request_id}:${ev.kind}:${ev.at}`,
    at: ev.at,
    read: false,
    requestId: ev.request_id,
    status: ev.status,
    href: `/approvals/${ev.request_id}`,
  }
  const mine = ev.requester_id === myId
  if (mine) {
    switch (ev.status) {
      case "approved":
      case "auto_approved":
        return { ...base, kind: "approval.approved", title: "申请已通过", body: ev.title }
      case "rejected":
        return { ...base, kind: "approval.rejected", title: "申请被驳回", body: ev.title }
      case "expired":
        return { ...base, kind: "approval.expired", title: "申请已超时", body: ev.title }
      default:
        return null // own pending / created — no need to notify the submitter
    }
  }
  // Approver side: surface newly arrived requests to review.
  if (ev.kind === "request.created" || ev.kind === "task.created") {
    return { ...base, kind: "approval.task", title: "有新的待审批申请", body: ev.title, href: "/approvals" }
  }
  return null
}

function emitToast(n: AppNotification) {
  switch (n.kind) {
    case "approval.approved":
      toast.success(n.title, { description: n.body })
      break
    case "approval.rejected":
      toast.error(n.title, { description: n.body })
      break
    case "approval.task":
      toast(n.title, { description: n.body })
      break
    default:
      break
  }
}
