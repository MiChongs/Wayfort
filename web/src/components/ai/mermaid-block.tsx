"use client"

import * as React from "react"
import { motion, useReducedMotion } from "motion/react"
import { useTheme } from "next-themes"
import { AlertCircle, Loader2 } from "lucide-react"

// Lazy-loaded Mermaid renderer. We don't bundle mermaid into the main chunk
// because it's heavy (~300 KB gzipped) and only needed when the model emits a
// ```mermaid``` block. We also re-render when the theme flips so the diagram
// colors match the surrounding UI.
let mermaidImportPromise: Promise<typeof import("mermaid").default> | null = null

function loadMermaid() {
  if (mermaidImportPromise) return mermaidImportPromise
  mermaidImportPromise = import("mermaid").then((m) => m.default)
  return mermaidImportPromise
}

let idCounter = 0
function nextId(): string {
  idCounter += 1
  return `mermaid-${Date.now()}-${idCounter}`
}

export function MermaidBlock({ source }: { source: string }) {
  const { resolvedTheme } = useTheme()
  const reduce = useReducedMotion()
  const [svg, setSvg] = React.useState<string | null>(null)
  const [error, setError] = React.useState<string | null>(null)

  React.useEffect(() => {
    let cancelled = false
    setError(null)
    setSvg(null)
    loadMermaid()
      .then(async (mermaid) => {
        if (cancelled) return
        mermaid.initialize({
          startOnLoad: false,
          theme: resolvedTheme === "dark" ? "dark" : "default",
          securityLevel: "strict",
          fontFamily: "var(--font-sans, system-ui)",
        })
        try {
          const { svg } = await mermaid.render(nextId(), source)
          if (!cancelled) setSvg(svg)
        } catch (e: unknown) {
          if (!cancelled) setError((e as Error).message)
        }
      })
      .catch((e: Error) => {
        if (!cancelled) setError(e.message)
      })
    return () => {
      cancelled = true
    }
  }, [source, resolvedTheme])

  if (error) {
    return (
      <div className="my-3 rounded-md border border-destructive/40 bg-destructive/5 px-3 py-2 text-xs">
        <div className="flex items-center gap-1.5 text-destructive font-medium">
          <AlertCircle className="w-3.5 h-3.5" /> Mermaid 渲染失败
        </div>
        <div className="text-muted-foreground mt-1 break-all">{error}</div>
        <pre className="mt-2 bg-muted text-foreground text-[11px] p-2 rounded font-mono overflow-auto">
          {source}
        </pre>
      </div>
    )
  }

  return (
    <motion.div
      layout={reduce ? false : "position"}
      transition={reduce ? { duration: 0 } : { duration: 0.2 }}
      className="my-3 rounded-md border border-border/60 bg-background p-3 overflow-x-auto flex justify-center"
    >
      {svg ? (
        <div
          className="mermaid-svg max-w-full"
          dangerouslySetInnerHTML={{ __html: svg }}
        />
      ) : (
        <div className="flex items-center gap-1.5 text-xs text-muted-foreground py-4">
          <Loader2 className="w-3.5 h-3.5 animate-spin" /> 渲染 Mermaid 图…
        </div>
      )}
    </motion.div>
  )
}
