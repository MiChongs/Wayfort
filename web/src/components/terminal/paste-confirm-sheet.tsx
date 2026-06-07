"use client"

// Phase 11 — replaces the legacy PasteConfirmDialog. Multi-line clipboard
// previews fit a Sheet much better than a Dialog: the preview pane gets a
// full vertical rail, and the user keeps page context (so they can see the
// terminal they're about to alter).

import * as React from "react"
import { ClipboardPaste, X } from "lucide-react"
import { Button } from "@/components/ui/button"
import { Badge } from "@/components/ui/badge"
import { ScrollArea } from "@/components/ui/scroll-area"
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetFooter,
  SheetHeader,
  SheetTitle,
} from "@/components/ui/sheet"

type Props = {
  text: string | null
  onConfirm: () => void
  onCancel: () => void
}

export function PasteConfirmSheet({ text, onConfirm, onCancel }: Props) {
  const lines = text ? text.split("\n").length : 0
  const chars = text?.length ?? 0
  const preview = text ?? ""
  const open = !!text
  return (
    <Sheet open={open} onOpenChange={(v) => !v && onCancel()}>
      <SheetContent side="right" className="flex w-full flex-col gap-0 p-0 sm:max-w-xl">
        <SheetHeader className="border-b px-6 pt-6 pb-4">
          <SheetTitle className="flex items-center gap-2 text-base">
            <ClipboardPaste className="h-4 w-4" /> 粘贴 {lines} 行内容?
          </SheetTitle>
          <SheetDescription>
            多行粘贴会被立即执行,确认无误后再继续 — 避免误粘脚本造成事故。
          </SheetDescription>
          <div className="flex flex-wrap gap-1.5 pt-2">
            <Badge variant="outline" className="font-normal">行数 {lines}</Badge>
            <Badge variant="outline" className="font-normal">字符 {chars.toLocaleString()}</Badge>
            {chars > 4096 && (
              <Badge variant="warning" className="font-normal">
                超长内容
              </Badge>
            )}
          </div>
        </SheetHeader>
        <ScrollArea className="min-h-0 flex-1 px-6 py-4">
          <pre className="rounded-md border bg-muted/40 p-3 font-mono text-xs leading-relaxed text-foreground whitespace-pre-wrap break-all">
            {preview}
          </pre>
        </ScrollArea>
        <SheetFooter className="flex-row items-center justify-end gap-2 border-t bg-muted/30 px-6 py-3">
          <Button variant="outline" onClick={onCancel}>
            <X className="h-4 w-4" /> 取消
          </Button>
          <Button onClick={onConfirm}>
            <ClipboardPaste className="h-4 w-4" /> 确认粘贴
          </Button>
        </SheetFooter>
      </SheetContent>
    </Sheet>
  )
}
