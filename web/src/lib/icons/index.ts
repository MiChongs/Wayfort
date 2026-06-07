// Public surface of the unified icon system.

import type { LucideIcon } from "lucide-react"
import { parseIconToken } from "./types"
import { LUCIDE_MAP } from "./lucide"
import { SIMPLE_MAP } from "./simple"

export * from "./types"
export { LUCIDE_ICONS, LUCIDE_MAP, LUCIDE_CATEGORIES, type LucideEntry } from "./lucide"
export { SIMPLE_ICONS, SIMPLE_MAP, SIMPLE_CATEGORIES, type SimpleEntry } from "./simple"
export { EMOJI_GROUPS, ALL_EMOJI, type EmojiGroup } from "./emoji"
export { PROTOCOL_ICON_TOKEN, protocolIconToken, nodeIcon } from "./protocol"

// A render-ready, discriminated description of an icon token.
export type ResolvedIcon =
  | { kind: "lucide"; Comp: LucideIcon }
  | { kind: "simple"; title: string; hex: string; path: string }
  | { kind: "emoji"; char: string }
  | { kind: "text"; text: string }
  | null

// resolveIcon turns a token into something `<AppIcon>` can render directly.
// Unknown lucide/simple names resolve to null so the caller can fall back.
export function resolveIcon(token?: string | null): ResolvedIcon {
  const p = parseIconToken(token)
  if (!p) return null
  if (p.lib === "lucide") {
    const Comp = LUCIDE_MAP[p.value] as LucideIcon | undefined
    return Comp ? { kind: "lucide", Comp } : null
  }
  if (p.lib === "simple") {
    const s = SIMPLE_MAP[p.value] as (typeof SIMPLE_MAP)[string] | undefined
    return s ? { kind: "simple", title: s.title, hex: s.hex, path: s.path } : null
  }
  if (p.lib === "emoji") return { kind: "emoji", char: p.value }
  return { kind: "text", text: p.value.slice(0, 2) }
}
