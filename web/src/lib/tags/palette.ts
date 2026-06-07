// Tag colour palette — the single source of truth for how a managed tag's
// `color` token renders. A token ("coral", "teal", …) maps to a coherent set of
// design-system classes (a tinted chip, a solid dot, a swatch for the picker)
// that stay legible in light AND dark. This keeps every tag on-palette instead
// of letting admins paste arbitrary hex.
//
// Backwards compatible: a tag whose `color` is a raw "#rrggbb" (legacy data, or
// a power-user override) is rendered verbatim via inline styles — see
// `resolveTagColor`. New tags always use tokens.
//
// The token list mirrors the Go side (internal/repo/asset_repo.go
// migrationPalette) so a migrated tag and a UI-created tag of the same name get
// the same hue.

import type { CSSProperties } from "react"

export type TagColorToken =
  | "coral"
  | "teal"
  | "amber"
  | "sage"
  | "sky"
  | "violet"
  | "rose"
  | "cyan"
  | "indigo"
  | "lime"
  | "fuchsia"
  | "slate"

export interface TagColorStyle {
  /** Tinted pill: background + text + border, light & dark aware. */
  chip: string
  /** Small solid status dot. */
  dot: string
  /** Solid fill — swatches in the colour picker, group headers. */
  solid: string
  /** Soft tint background only (no text colour) — section headers. */
  soft: string
  /** Text colour only — for icons / emphasis on a neutral surface. */
  text: string
}

// Every class is written out in full (no `bg-${c}-500` interpolation) so
// Tailwind's JIT actually emits them.
const PALETTE: Record<TagColorToken, TagColorStyle> = {
  // Coral == the brand primary, so it threads through the design tokens.
  coral: {
    chip: "bg-primary/12 text-primary border-primary/25",
    dot: "bg-primary",
    solid: "bg-primary text-primary-foreground",
    soft: "bg-primary/10",
    text: "text-primary",
  },
  teal: {
    chip: "bg-teal-500/15 text-teal-700 dark:text-teal-300 border-teal-500/25",
    dot: "bg-teal-500",
    solid: "bg-teal-500 text-white",
    soft: "bg-teal-500/10",
    text: "text-teal-600 dark:text-teal-400",
  },
  amber: {
    chip: "bg-amber-500/15 text-amber-700 dark:text-amber-300 border-amber-500/25",
    dot: "bg-amber-500",
    solid: "bg-amber-500 text-white",
    soft: "bg-amber-500/10",
    text: "text-amber-600 dark:text-amber-400",
  },
  sage: {
    chip: "bg-emerald-500/15 text-emerald-700 dark:text-emerald-300 border-emerald-500/25",
    dot: "bg-emerald-500",
    solid: "bg-emerald-500 text-white",
    soft: "bg-emerald-500/10",
    text: "text-emerald-600 dark:text-emerald-400",
  },
  sky: {
    chip: "bg-sky-500/15 text-sky-700 dark:text-sky-300 border-sky-500/25",
    dot: "bg-sky-500",
    solid: "bg-sky-500 text-white",
    soft: "bg-sky-500/10",
    text: "text-sky-600 dark:text-sky-400",
  },
  violet: {
    chip: "bg-violet-500/15 text-violet-700 dark:text-violet-300 border-violet-500/25",
    dot: "bg-violet-500",
    solid: "bg-violet-500 text-white",
    soft: "bg-violet-500/10",
    text: "text-violet-600 dark:text-violet-400",
  },
  rose: {
    chip: "bg-rose-500/15 text-rose-700 dark:text-rose-300 border-rose-500/25",
    dot: "bg-rose-500",
    solid: "bg-rose-500 text-white",
    soft: "bg-rose-500/10",
    text: "text-rose-600 dark:text-rose-400",
  },
  cyan: {
    chip: "bg-cyan-500/15 text-cyan-700 dark:text-cyan-300 border-cyan-500/25",
    dot: "bg-cyan-500",
    solid: "bg-cyan-500 text-white",
    soft: "bg-cyan-500/10",
    text: "text-cyan-600 dark:text-cyan-400",
  },
  indigo: {
    chip: "bg-indigo-500/15 text-indigo-700 dark:text-indigo-300 border-indigo-500/25",
    dot: "bg-indigo-500",
    solid: "bg-indigo-500 text-white",
    soft: "bg-indigo-500/10",
    text: "text-indigo-600 dark:text-indigo-400",
  },
  lime: {
    chip: "bg-lime-500/15 text-lime-700 dark:text-lime-300 border-lime-500/25",
    dot: "bg-lime-500",
    solid: "bg-lime-500 text-white",
    soft: "bg-lime-500/10",
    text: "text-lime-600 dark:text-lime-400",
  },
  fuchsia: {
    chip: "bg-fuchsia-500/15 text-fuchsia-700 dark:text-fuchsia-300 border-fuchsia-500/25",
    dot: "bg-fuchsia-500",
    solid: "bg-fuchsia-500 text-white",
    soft: "bg-fuchsia-500/10",
    text: "text-fuchsia-600 dark:text-fuchsia-400",
  },
  slate: {
    chip: "bg-slate-500/15 text-slate-700 dark:text-slate-300 border-slate-500/25",
    dot: "bg-slate-500",
    solid: "bg-slate-500 text-white",
    soft: "bg-slate-500/10",
    text: "text-slate-600 dark:text-slate-400",
  },
}

// Ordered token list for the swatch picker.
export const TAG_COLOR_TOKENS = Object.keys(PALETTE) as TagColorToken[]

export const DEFAULT_TAG_COLOR: TagColorToken = "slate"

// Friendly Chinese labels for each swatch (tooltip / a11y).
export const TAG_COLOR_LABELS: Record<TagColorToken, string> = {
  coral: "珊瑚",
  teal: "青",
  amber: "琥珀",
  sage: "鼠尾草绿",
  sky: "天蓝",
  violet: "紫罗兰",
  rose: "玫瑰",
  cyan: "青蓝",
  indigo: "靛蓝",
  lime: "柠檬绿",
  fuchsia: "品红",
  slate: "石板灰",
}

function isToken(c: string): c is TagColorToken {
  return Object.prototype.hasOwnProperty.call(PALETTE, c)
}

function looksLikeCss(c: string): boolean {
  return /^#([0-9a-f]{3}|[0-9a-f]{6}|[0-9a-f]{8})$/i.test(c) || /^[a-z]+$/i.test(c)
}

export interface ResolvedTagColor {
  style: TagColorStyle
  /** When the colour is a raw hex/css (legacy), inline styles to apply instead. */
  inline?: { chip: CSSProperties; dot: CSSProperties; swatch: CSSProperties }
  token: TagColorToken | null
}

// resolveTagColor turns a stored color string into render-ready styles.
//   - known token  → palette classes
//   - "#rrggbb"    → inline-style fallback (chip uses a soft tint via colour-mix)
//   - empty/unknown→ deterministic token by `seed` (usually the tag name) so an
//     un-coloured tag still gets a stable, pleasant hue.
export function resolveTagColor(color?: string | null, seed?: string): ResolvedTagColor {
  const c = (color || "").trim()
  if (c && isToken(c)) {
    return { style: PALETTE[c], token: c }
  }
  if (c && !isToken(c) && /^#/.test(c) && looksLikeCss(c)) {
    return {
      style: PALETTE[DEFAULT_TAG_COLOR],
      token: null,
      inline: {
        chip: {
          backgroundColor: `color-mix(in oklab, ${c} 15%, transparent)`,
          color: c,
          borderColor: `color-mix(in oklab, ${c} 30%, transparent)`,
        },
        dot: { backgroundColor: c },
        swatch: { backgroundColor: c },
      },
    }
  }
  // Empty / unknown → deterministic fallback by seed.
  return { style: PALETTE[defaultTagColor(seed || "")], token: defaultTagColor(seed || "") }
}

// defaultTagColor picks a stable token from a seed string (FNV-1a, matching the
// Go migration) so the same tag name always lands on the same hue.
export function defaultTagColor(seed: string): TagColorToken {
  let h = 2166136261
  for (let i = 0; i < seed.length; i++) {
    h ^= seed.charCodeAt(i)
    h = Math.imul(h, 16777619)
  }
  return TAG_COLOR_TOKENS[Math.abs(h) % TAG_COLOR_TOKENS.length]
}

export function tagColorStyle(token: TagColorToken): TagColorStyle {
  return PALETTE[token]
}
