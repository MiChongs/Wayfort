"use client"

import * as React from "react"
import { TerminalSquare } from "lucide-react"
import { Button } from "@/components/ui/button"
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip"
import { cn } from "@/lib/utils"
import { useWorkspaceStore } from "../useWorkspaceStore"

// Shared primitives for the SSH ops dock subtabs. Keeps every tool consistent:
// the same typed-error shape, the same "run in terminal" affordance, and the
// same dock→terminal bridge access.

export type ApiError = { message?: string; status?: number; detail?: { code?: string } | unknown }

/** Extracts the machine-readable `code` a typed backend error carries. */
export function codeOf(e: unknown): string | undefined {
  if (e && typeof e === "object" && "detail" in e) {
    const d = (e as ApiError).detail
    if (d && typeof d === "object" && "code" in d) {
      return String((d as { code?: string }).code ?? "") || undefined
    }
  }
  return undefined
}

/**
 * useSendToTerminal returns a stable `send(text, run?)` that pushes a command
 * into this tab's live WebSSH terminal via the store bridge. `run` (default
 * true) appends a newline so the shell executes it; pass false to only type it
 * at the prompt for the operator to review.
 */
export function useSendToTerminal(tabId: string | undefined) {
  const sendToTerminal = useWorkspaceStore((s) => s.sendToTerminal)
  return React.useCallback(
    (text: string, run = true) => {
      if (!tabId || !text.trim()) return
      sendToTerminal(tabId, text, run)
    },
    [tabId, sendToTerminal],
  )
}

/**
 * RunInTerminalButton — the canonical "把这条命令打到当前终端" affordance used
 * across every ops tool. Defaults to a compact ghost icon button.
 */
export function RunInTerminalButton({
  tabId,
  command,
  run = false,
  label = "在终端运行",
  className,
  size = "icon",
}: {
  tabId: string | undefined
  command: string
  /** true = execute immediately; false = type at the prompt for review (default). */
  run?: boolean
  label?: string
  className?: string
  size?: "icon" | "sm"
}) {
  const send = useSendToTerminal(tabId)
  const disabled = !tabId || !command.trim()
  if (size === "sm") {
    return (
      <Button
        type="button"
        variant="outline"
        size="sm"
        className={cn("h-7 text-xs gap-1", className)}
        disabled={disabled}
        onClick={() => send(command, run)}
        title={label}
      >
        <TerminalSquare className="w-3.5 h-3.5" /> {label}
      </Button>
    )
  }
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <Button
          type="button"
          variant="ghost"
          size="icon"
          className={cn("h-6 w-6", className)}
          disabled={disabled}
          onClick={() => send(command, run)}
        >
          <TerminalSquare className="w-3 h-3" />
        </Button>
      </TooltipTrigger>
      <TooltipContent side="left">{label}</TooltipContent>
    </Tooltip>
  )
}
