// Group runs of ≥3 consecutive same-name tool bubbles into one collapsed
// summary card. Two consecutive of the same name stays individual; if the
// chain hits 3 we merge that whole run.
//
// Generic so it can wrap both live LiveBubble[] and rendered history items.

import type { ToolStatus } from "@/components/ai/tool-card"

export interface ToolLike {
  id: string
  name: string
  status: ToolStatus
  output?: string
  error?: string
  danger?: boolean
}

export interface GroupedTool extends ToolLike {
  __kind: "tool"
}

export interface ToolGroup {
  __kind: "group"
  name: string
  groupKey: string // first item id; stable for motion AnimatePresence
  items: ToolLike[]
}

const MIN_GROUP_SIZE = 3

/**
 * groupTools takes a list of inputs (any shape carrying a `name` and being a
 * tool entry, plus other items it doesn't touch), and folds runs of ≥3
 * consecutive entries of the same tool name into one ToolGroup.
 *
 * `isTool` tells the algorithm which inputs are tools; non-tool entries are
 * passed through verbatim.
 * `extract` projects a tool entry to its ToolLike shape.
 */
export function groupTools<T>(
  items: T[],
  isTool: (item: T) => boolean,
  extract: (item: T) => ToolLike,
): Array<T | ToolGroup> {
  const out: Array<T | ToolGroup> = []
  let i = 0
  while (i < items.length) {
    const cur = items[i]
    if (!isTool(cur)) {
      out.push(cur)
      i++
      continue
    }
    const curTool = extract(cur)
    // Scan forward for consecutive same-name tools.
    let j = i + 1
    while (j < items.length && isTool(items[j]) && extract(items[j]).name === curTool.name) {
      j++
    }
    const runLength = j - i
    if (runLength >= MIN_GROUP_SIZE) {
      const tools: ToolLike[] = []
      for (let k = i; k < j; k++) tools.push(extract(items[k]))
      out.push({
        __kind: "group",
        name: curTool.name,
        groupKey: tools[0].id,
        items: tools,
      })
      i = j
    } else {
      // Run too short: emit each individually.
      for (let k = i; k < j; k++) out.push(items[k])
      i = j
    }
  }
  return out
}
