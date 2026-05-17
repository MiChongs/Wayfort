import type { AIConversation } from "@/lib/api/types"

export type ConversationBucketKey = "today" | "yesterday" | "week" | "month" | "earlier"

export interface ConversationBucket {
  key: ConversationBucketKey
  label: string
  items: AIConversation[]
}

const DAY_MS = 24 * 60 * 60 * 1000

export function groupConversations(convs: AIConversation[]): ConversationBucket[] {
  const buckets: Record<ConversationBucketKey, AIConversation[]> = {
    today: [],
    yesterday: [],
    week: [],
    month: [],
    earlier: [],
  }
  const now = Date.now()
  const startOfToday = new Date()
  startOfToday.setHours(0, 0, 0, 0)
  const todayMs = startOfToday.getTime()
  const yesterdayMs = todayMs - DAY_MS

  for (const c of convs) {
    const t = c.updated_at ? new Date(c.updated_at).getTime() : 0
    if (Number.isNaN(t)) {
      buckets.earlier.push(c)
      continue
    }
    if (t >= todayMs) buckets.today.push(c)
    else if (t >= yesterdayMs) buckets.yesterday.push(c)
    else if (now - t <= 7 * DAY_MS) buckets.week.push(c)
    else if (now - t <= 30 * DAY_MS) buckets.month.push(c)
    else buckets.earlier.push(c)
  }

  const labels: Record<ConversationBucketKey, string> = {
    today: "今天",
    yesterday: "昨天",
    week: "本周",
    month: "本月",
    earlier: "更早",
  }
  const order: ConversationBucketKey[] = ["today", "yesterday", "week", "month", "earlier"]
  return order
    .map((k) => ({ key: k, label: labels[k], items: buckets[k] }))
    .filter((b) => b.items.length > 0)
}
