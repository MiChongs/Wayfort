"use client"

import * as React from "react"
import { motion, useReducedMotion } from "motion/react"
import { Menu } from "lucide-react"
import { Button } from "@/components/ui/button"
import {
  Sheet,
  SheetContent,
  SheetTitle,
} from "@/components/ui/sheet"
import { ConversationSidebar } from "@/components/ai/conversation-sidebar"
import { useMediaQuery } from "@/lib/hooks/use-media-query"

export default function AILayout({ children }: { children: React.ReactNode }) {
  const isDesktop = useMediaQuery("(min-width: 768px)")
  const reduce = useReducedMotion()
  const [open, setOpen] = React.useState(false)

  // Pin the entire AI shell to the viewport minus the global TopBar (h-14).
  // We can't rely on h-full propagating cleanly because the parent <main>
  // uses overflow-y-auto, so any descendant momentarily taller than its
  // computed height would let main scroll the whole page (composer
  // included). dvh handles mobile chrome resizing.
  return (
    <div className="flex w-full overflow-hidden h-[calc(100dvh-56px)] max-h-[calc(100dvh-56px)]">
      {isDesktop && (
        <motion.div
          initial={reduce ? false : { x: -20, opacity: 0 }}
          animate={{ x: 0, opacity: 1 }}
          transition={reduce ? { duration: 0 } : { duration: 0.25, ease: "easeOut" }}
          className="w-72 shrink-0"
        >
          <ConversationSidebar />
        </motion.div>
      )}

      {!isDesktop && (
        <Sheet open={open} onOpenChange={setOpen}>
          <SheetContent side="left" className="p-0 w-[280px] sm:max-w-[300px]">
            <SheetTitle className="sr-only">AI 对话列表</SheetTitle>
            <ConversationSidebar onAfterPick={() => setOpen(false)} />
          </SheetContent>
        </Sheet>
      )}

      <div className="flex-1 min-w-0 flex flex-col bg-background">
        {!isDesktop && (
          <div className="border-b px-3 py-2 flex items-center gap-2">
            <Button
              variant="ghost"
              size="icon"
              onClick={() => setOpen(true)}
              className="h-8 w-8"
            >
              <Menu className="w-4 h-4" />
            </Button>
            <span className="text-sm font-medium">AI 助手</span>
          </div>
        )}
        <div className="flex-1 min-h-0 overflow-hidden">{children}</div>
      </div>
    </div>
  )
}
