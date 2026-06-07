// Unified icon token system. Any entity stores its icon as ONE string token so
// the same `<AppIcon>` renderer + `<IconPicker>` work everywhere across multiple
// icon libraries:
//
//   "lucide:server"        → a Lucide line icon
//   "simple:postgresql"    → a Simple Icons brand glyph (with brand colour)
//   "emoji:🐳"             → an emoji
//   "text:DB"              → 1–2 letters rendered as a tinted avatar tile
//
// Backwards compatible: a bare value with no "<lib>:" prefix is treated as an
// emoji if it contains non-ASCII (the old tag emoji fields), otherwise as text.

export type IconLib = "lucide" | "simple" | "emoji" | "text"

export interface ParsedIcon {
  lib: IconLib
  value: string
}

const KNOWN_LIBS: Record<string, IconLib> = {
  lucide: "lucide",
  simple: "simple",
  emoji: "emoji",
  text: "text",
}

const NON_ASCII = /[^\x00-\x7f]/

export function parseIconToken(token?: string | null): ParsedIcon | null {
  const t = (token || "").trim()
  if (!t) return null
  const i = t.indexOf(":")
  if (i > 0) {
    const lib = t.slice(0, i).toLowerCase()
    const value = t.slice(i + 1)
    if (lib in KNOWN_LIBS && value) return { lib: KNOWN_LIBS[lib], value }
  }
  // Prefix-less shorthand (legacy emoji fields, or a typed letter). Any
  // non-ASCII char → emoji; otherwise a short text label.
  if (NON_ASCII.test(t)) return { lib: "emoji", value: t }
  return { lib: "text", value: t.slice(0, 2) }
}

export function iconToken(lib: IconLib, value: string): string {
  return `${lib}:${value}`
}

export function isIconToken(token?: string | null): boolean {
  return parseIconToken(token) !== null
}
