"use client"

import * as React from "react"
import Link from "next/link"
import { Bell } from "lucide-react"
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover"
import { Button } from "@/components/ui/button"
import { ScrollArea } from "@/components/ui/scroll-area"
import { useNotifications } from "./notification-provider"
import { relTime } from "@/lib/format"
import { cn } from "@/lib/utils"

const KIND_DOT: Record<string, string> = {
  "approval.approved": "bg-emerald-500",
  "approval.rejected": "bg-destructive",
  "approval.expired": "bg-muted-foreground/50",
  "approval.task": "bg-amber-500",
}

export function NotificationBell() {
  const { notifications, unreadCount, markAllRead, markRead } = useNotifications()
  const [open, setOpen] = React.useState(false)

  return (
    <Popover
      open={open}
      onOpenChange={(o) => {
        setOpen(o)
        if (o && unreadCount > 0) markAllRead()
      }}
    >
      <PopoverTrigger asChild>
        <Button variant="ghost" size="icon" aria-label="通知" className="relative">
          <Bell className="h-4 w-4" />
          {unreadCount > 0 && (
            <span className="absolute right-0.5 top-0.5 grid h-4 min-w-[16px] place-items-center rounded-full bg-primary px-1 text-[10px] font-medium leading-none text-primary-foreground">
              {unreadCount > 99 ? "99+" : unreadCount}
            </span>
          )}
        </Button>
      </PopoverTrigger>
      <PopoverContent align="end" className="w-80 p-0">
        <div className="flex items-center justify-between border-b border-border px-3 py-2">
          <span className="text-sm font-medium">通知</span>
          {notifications.length > 0 && (
            <button
              type="button"
              onClick={markAllRead}
              className="text-xs text-muted-foreground transition-colors hover:text-foreground"
            >
              全部已读
            </button>
          )}
        </div>
        <ScrollArea className="max-h-96">
          {notifications.length === 0 ? (
            <div className="px-3 py-10 text-center text-sm text-muted-foreground">暂无通知</div>
          ) : (
            <ul className="divide-y divide-border/60">
              {notifications.map((n) => (
                <li key={n.id}>
                  <Link
                    href={n.href ?? "/approvals"}
                    onClick={() => {
                      markRead(n.id)
                      setOpen(false)
                    }}
                    className={cn(
                      "flex gap-2.5 px-3 py-2.5 transition-colors hover:bg-accent/50",
                      !n.read && "bg-primary/[0.03]",
                    )}
                  >
                    <span className={cn("mt-1.5 h-1.5 w-1.5 shrink-0 rounded-full", KIND_DOT[n.kind] ?? "bg-border")} />
                    <div className="min-w-0 flex-1">
                      <div className="flex items-center gap-2">
                        <span className="truncate text-sm font-medium">{n.title}</span>
                        <span className="ml-auto shrink-0 text-[11px] text-muted-foreground">{relTime(n.at)}</span>
                      </div>
                      {n.body && <div className="truncate text-xs text-muted-foreground">{n.body}</div>}
                    </div>
                  </Link>
                </li>
              ))}
            </ul>
          )}
        </ScrollArea>
      </PopoverContent>
    </Popover>
  )
}
