"use client"

import * as React from "react"
import { Check, Copy } from "lucide-react"
import { Button } from "@/components/ui/button"
import { toast } from "@/components/ui/sonner"
import { cn } from "@/lib/utils"

// Reusable copy-to-clipboard. Inline icon button with two-second checkmark state.
export function CopyButton({
  value,
  className,
  label,
  size = "icon",
  variant = "ghost",
}: {
  value: string
  className?: string
  label?: string
  size?: "icon" | "sm"
  variant?: "ghost" | "outline" | "secondary"
}) {
  const [done, setDone] = React.useState(false)
  return (
    <Button
      variant={variant}
      size={size}
      className={cn(className)}
      onClick={async (e) => {
        e.stopPropagation()
        try {
          await navigator.clipboard.writeText(value)
          setDone(true)
          toast.success("已复制")
          setTimeout(() => setDone(false), 1500)
        } catch {
          toast.error("复制失败：浏览器拒绝写入剪贴板")
        }
      }}
      aria-label="复制"
    >
      {done ? <Check className="w-4 h-4" /> : <Copy className="w-4 h-4" />}
      {label && <span className="ml-1">{label}</span>}
    </Button>
  )
}
