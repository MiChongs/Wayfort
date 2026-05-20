"use client"

// ConfirmDelete — shadcn AlertDialog wrapper that replaces native `confirm()`
// calls across the admin surface. Two variants:
//  1. ConfirmDeleteIconButton: drop-in `<Button variant=ghost size=icon>` you
//     can substitute anywhere we previously rendered a trash icon with a
//     window.confirm() onClick handler.
//  2. ConfirmDeleteDialog: standalone controlled component for callers that
//     already have their own trigger.

import * as React from "react"
import { Loader2, Trash2 } from "lucide-react"
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
  AlertDialogTrigger,
} from "@/components/ui/alert-dialog"
import { Button } from "@/components/ui/button"
import { cn } from "@/lib/utils"

export interface ConfirmDeleteProps {
  title?: string
  description?: React.ReactNode
  confirmLabel?: string
  cancelLabel?: string
  loading?: boolean
  destructive?: boolean
  onConfirm: () => void | Promise<void>
}

export function ConfirmDeleteIconButton({
  className,
  iconClassName,
  title = "确认删除？",
  description = "该操作不可恢复。请确认要继续。",
  confirmLabel = "删除",
  cancelLabel = "取消",
  loading,
  destructive = true,
  onConfirm,
}: ConfirmDeleteProps & { className?: string; iconClassName?: string }) {
  const [open, setOpen] = React.useState(false)
  return (
    <AlertDialog open={open} onOpenChange={setOpen}>
      <AlertDialogTrigger asChild>
        <Button variant="ghost" size="icon" className={className} aria-label={title}>
          <Trash2 className={cn("h-4 w-4", destructive ? "text-destructive" : "text-muted-foreground", iconClassName)} />
        </Button>
      </AlertDialogTrigger>
      <ConfirmDeleteBody
        title={title}
        description={description}
        confirmLabel={confirmLabel}
        cancelLabel={cancelLabel}
        loading={loading}
        destructive={destructive}
        onConfirm={async () => {
          await onConfirm()
          setOpen(false)
        }}
      />
    </AlertDialog>
  )
}

export function ConfirmDeleteDialog({
  open,
  onOpenChange,
  ...props
}: ConfirmDeleteProps & { open: boolean; onOpenChange: (v: boolean) => void }) {
  return (
    <AlertDialog open={open} onOpenChange={onOpenChange}>
      <ConfirmDeleteBody
        {...props}
        onConfirm={async () => {
          await props.onConfirm()
          onOpenChange(false)
        }}
      />
    </AlertDialog>
  )
}

function ConfirmDeleteBody({
  title = "确认删除？",
  description = "该操作不可恢复。请确认要继续。",
  confirmLabel = "删除",
  cancelLabel = "取消",
  loading,
  destructive = true,
  onConfirm,
}: ConfirmDeleteProps) {
  return (
    <AlertDialogContent>
      <AlertDialogHeader>
        <AlertDialogTitle className="flex items-center gap-2">
          <Trash2 className={cn("h-4 w-4", destructive && "text-destructive")} />
          {title}
        </AlertDialogTitle>
        <AlertDialogDescription>{description}</AlertDialogDescription>
      </AlertDialogHeader>
      <AlertDialogFooter>
        <AlertDialogCancel disabled={loading}>{cancelLabel}</AlertDialogCancel>
        <AlertDialogAction
          onClick={(e) => {
            e.preventDefault()
            void onConfirm()
          }}
          disabled={loading}
          className={destructive ? "bg-destructive text-destructive-foreground hover:bg-destructive/90" : undefined}
        >
          {loading ? <Loader2 className="h-4 w-4 animate-spin" /> : null}
          {confirmLabel}
        </AlertDialogAction>
      </AlertDialogFooter>
    </AlertDialogContent>
  )
}
