"use client"

import * as React from "react"
import { Input } from "@/components/ui/input"

type Props = {
  initial: string
  onSubmit: (value: string) => void
  onCancel: () => void
}

export function SftpRenameInline({ initial, onSubmit, onCancel }: Props) {
  const [value, setValue] = React.useState(initial)
  const ref = React.useRef<HTMLInputElement>(null)

  React.useEffect(() => {
    const t = setTimeout(() => {
      const el = ref.current
      if (!el) return
      el.focus()
      // Select the basename (without extension) — typical "rename" UX so the
      // user can tap a letter without nuking ".tar.gz".
      const dot = initial.lastIndexOf(".")
      if (dot > 0 && dot < initial.length - 1) el.setSelectionRange(0, dot)
      else el.select()
    }, 0)
    return () => clearTimeout(t)
  }, [initial])

  return (
    <Input
      ref={ref}
      value={value}
      onChange={(e) => setValue(e.target.value)}
      onKeyDown={(e) => {
        if (e.key === "Enter") {
          e.preventDefault()
          const v = value.trim()
          if (!v || v === initial) onCancel()
          else onSubmit(v)
        }
        if (e.key === "Escape") {
          e.preventDefault()
          onCancel()
        }
        e.stopPropagation()
      }}
      onClick={(e) => e.stopPropagation()}
      onBlur={() => {
        const v = value.trim()
        if (!v || v === initial) onCancel()
        else onSubmit(v)
      }}
      className="h-6 px-1 py-0 text-sm w-full"
      spellCheck={false}
      autoComplete="off"
    />
  )
}
