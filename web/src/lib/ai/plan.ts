// Shared types + helpers for the long-horizon agent's live task panel. The
// backend maintains the plan via the runner-intercepted `update_plan` tool
// (full-array replace) and streams it as the `plan_update` SSE event; it also
// rides on the conversation GET as `plan`.

export type AgentTaskStatus = "pending" | "active" | "done" | "skipped" | "failed"

export interface AgentTask {
  id: number
  ordinal: number
  title: string
  detail?: string
  status: AgentTaskStatus
}

export interface AgentPlan {
  tasks: AgentTask[]
  updatedAt?: number
}

export const EMPTY_PLAN: AgentPlan = { tasks: [] }

export interface PlanProgress {
  total: number
  done: number
  active: number
  pct: number
}

export function planProgress(tasks: AgentTask[]): PlanProgress {
  let done = 0
  let active = 0
  for (const t of tasks) {
    if (t.status === "done" || t.status === "skipped") done++
    else if (t.status === "active") active++
  }
  const total = tasks.length
  return { total, done, active, pct: total ? Math.round((done / total) * 100) : 0 }
}

export interface StatusMeta {
  label: string
  // Tailwind bg-* token for the status dot (warm semantic colors only — never
  // coral, never cool accents; per DESIGN.md).
  dotClass: string
  pulse?: boolean
  strike?: boolean
}

export function statusMeta(status: AgentTaskStatus): StatusMeta {
  switch (status) {
    case "done":
      return { label: "完成", dotClass: "bg-success" }
    case "active":
      return { label: "进行中", dotClass: "bg-warning", pulse: true }
    case "failed":
      return { label: "失败", dotClass: "bg-destructive" }
    case "skipped":
      return { label: "跳过", dotClass: "bg-muted-foreground/40", strike: true }
    default:
      return { label: "待办", dotClass: "bg-muted-foreground/35" }
  }
}

// mergePlanUpdate folds an incoming `plan_update` (the complete ordered task
// array) into a fresh AgentPlan. Kept as a function so the page reducer stays
// declarative; `stamp` lets callers thread a monotonic counter instead of
// Date.now() when they need deterministic ordering.
export function mergePlanUpdate(tasks: AgentTask[], stamp?: number): AgentPlan {
  const sorted = [...tasks].sort((a, b) => a.ordinal - b.ordinal)
  return { tasks: sorted, updatedAt: stamp ?? (typeof performance !== "undefined" ? performance.now() : 0) }
}
