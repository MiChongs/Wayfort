"use client"

import { User } from "lucide-react"
import { CopyButton } from "@/components/common/copy-button"

export function UserBubble({ text }: { text: string }) {
  return (
    <div className="flex justify-end gap-3 group">
      <div className="opacity-0 group-hover:opacity-100 transition-opacity flex items-start pt-1">
        <CopyButton value={text} variant="ghost" />
      </div>
      <div className="bg-primary text-primary-foreground rounded-2xl rounded-tr-md px-4 py-2.5 max-w-[80%] md:max-w-2xl whitespace-pre-wrap break-words shadow-sm">
        {text}
      </div>
      <div className="w-7 h-7 rounded-full bg-primary/90 text-primary-foreground flex items-center justify-center shrink-0 shadow-sm">
        <User className="w-4 h-4" />
      </div>
    </div>
  )
}
