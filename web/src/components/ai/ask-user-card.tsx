"use client"

import * as React from "react"
import { motion, useReducedMotion } from "motion/react"
import { Check, CircleHelp, Send } from "lucide-react"
import { Button } from "@/components/ui/button"
import { Textarea } from "@/components/ui/textarea"
import { cn } from "@/lib/utils"

// Renders the agent's structured question (the ask_user tool). The user picks
// option(s) and/or types free text, then submits — the answer flows back to the
// model as the tool result. Self-contained: once submitted it shows the chosen
// answer and locks, so we don't depend on the stream to dismiss it.
export function AskUserCard({
  question,
  options,
  allowMultiple,
  allowText,
  onSubmit,
}: {
  question: string
  options: { label: string; description?: string }[]
  allowMultiple: boolean
  allowText: boolean
  onSubmit: (text: string) => void
}) {
  const reduce = useReducedMotion()
  const [selected, setSelected] = React.useState<string[]>([])
  const [text, setText] = React.useState("")
  const [submitted, setSubmitted] = React.useState<string | null>(null)

  const toggle = (label: string) => {
    if (submitted) return
    setSelected((prev) =>
      allowMultiple
        ? prev.includes(label)
          ? prev.filter((x) => x !== label)
          : [...prev, label]
        : [label],
    )
  }

  const compose = () => {
    const parts = [...selected]
    if (text.trim()) parts.push(text.trim())
    return parts.join("；")
  }

  const canSubmit = !submitted && (selected.length > 0 || text.trim().length > 0)

  const submit = () => {
    const ans = compose()
    if (!ans) return
    setSubmitted(ans)
    onSubmit(ans)
  }

  return (
    <div className="flex gap-3">
      <div className="flex h-7 w-7 shrink-0 items-center justify-center rounded-full border border-primary/30 bg-primary/10 text-primary">
        <CircleHelp className="h-3.5 w-3.5" />
      </div>
      <motion.div
        className="min-w-0 max-w-3xl flex-1"
        initial={reduce ? false : { opacity: 0, y: 6 }}
        animate={{ opacity: 1, y: 0 }}
        transition={reduce ? { duration: 0 } : { type: "spring", stiffness: 380, damping: 34 }}
      >
        <div className="overflow-hidden rounded-xl border border-primary/25 bg-primary/[0.03]">
          <div className="border-b border-primary/15 px-4 py-2">
            <span className="eyebrow text-primary/80">Agent 需要你的决定</span>
          </div>
          <div className="space-y-3 px-4 py-3">
            <div className="text-sm font-medium leading-relaxed">{question}</div>

            {options.length > 0 && (
              <div className="space-y-1.5">
                {options.map((o) => {
                  const on = selected.includes(o.label)
                  return (
                    <button
                      key={o.label}
                      type="button"
                      onClick={() => toggle(o.label)}
                      disabled={!!submitted}
                      className={cn(
                        "flex w-full items-start gap-2.5 rounded-lg border p-2.5 text-left text-sm transition-colors",
                        on ? "border-primary bg-primary/10" : "border-border hover:bg-accent",
                        submitted && "opacity-70",
                      )}
                    >
                      <span
                        className={cn(
                          "mt-0.5 flex h-4 w-4 shrink-0 items-center justify-center border",
                          allowMultiple ? "rounded-[5px]" : "rounded-full",
                          on ? "border-primary bg-primary text-primary-foreground" : "border-input",
                        )}
                      >
                        {on && <Check className="h-3 w-3" />}
                      </span>
                      <span className="min-w-0">
                        <span className="font-medium">{o.label}</span>
                        {o.description && (
                          <span className="mt-0.5 block text-[11px] leading-relaxed text-muted-foreground">
                            {o.description}
                          </span>
                        )}
                      </span>
                    </button>
                  )
                })}
              </div>
            )}

            {allowText && !submitted && (
              <Textarea
                rows={options.length > 0 ? 2 : 3}
                value={text}
                onChange={(e) => setText(e.target.value)}
                placeholder={options.length > 0 ? "补充说明（可选）…" : "输入你的回答…"}
                onKeyDown={(e) => {
                  if ((e.metaKey || e.ctrlKey) && e.key === "Enter") {
                    e.preventDefault()
                    submit()
                  }
                }}
              />
            )}

            {submitted ? (
              <div className="flex items-center gap-1.5 rounded-md bg-emerald-500/10 px-2.5 py-1.5 text-xs text-emerald-700 dark:text-emerald-300">
                <Check className="h-3.5 w-3.5" /> 你的回答：{submitted}
              </div>
            ) : (
              <div className="flex justify-end">
                <Button size="sm" onClick={submit} disabled={!canSubmit}>
                  <Send className="h-3.5 w-3.5" /> 提交回答
                </Button>
              </div>
            )}
          </div>
        </div>
      </motion.div>
    </div>
  )
}
