"use client"

// useConfirm — promisified shadcn AlertDialog. Replaces the native `confirm()`
// call sites that aren't tied to a static trigger button (e.g. deep inside a
// reducer / handler chain). The returned `dialog` element must be rendered
// somewhere in the tree; `confirm()` opens it and resolves with the user's
// answer.

import * as React from "react"
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog"
import { Trash2 } from "lucide-react"
import { cn } from "@/lib/utils"

export interface ConfirmOptions {
  title: string
  description?: React.ReactNode
  confirmLabel?: string
  cancelLabel?: string
  destructive?: boolean
}

export function useConfirm(): {
  confirm: (opts: ConfirmOptions) => Promise<boolean>
  dialog: React.ReactNode
} {
  const [state, setState] = React.useState<ConfirmOptions | null>(null)
  const resolverRef = React.useRef<((v: boolean) => void) | null>(null)

  const confirm = React.useCallback((opts: ConfirmOptions) => {
    return new Promise<boolean>((resolve) => {
      resolverRef.current = resolve
      setState(opts)
    })
  }, [])

  const close = (value: boolean) => {
    resolverRef.current?.(value)
    resolverRef.current = null
    setState(null)
  }

  const dialog = (
    <AlertDialog open={state !== null} onOpenChange={(open) => !open && close(false)}>
      {state && (
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle className="flex items-center gap-2">
              {state.destructive !== false && <Trash2 className="h-4 w-4 text-destructive" />}
              {state.title}
            </AlertDialogTitle>
            {state.description && (
              <AlertDialogDescription>{state.description}</AlertDialogDescription>
            )}
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel onClick={() => close(false)}>
              {state.cancelLabel ?? "取消"}
            </AlertDialogCancel>
            <AlertDialogAction
              className={cn(
                state.destructive !== false &&
                  "bg-destructive text-destructive-foreground hover:bg-destructive/90",
              )}
              onClick={() => close(true)}
            >
              {state.confirmLabel ?? "确认"}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      )}
    </AlertDialog>
  )

  return { confirm, dialog }
}
