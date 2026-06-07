"use client"

import * as React from "react"
import type { TerminalThemeName } from "./terminal-themes"

// Single source of truth for everything users can tweak about the terminal.
// Stored in localStorage as one JSON blob so reads/writes are atomic and
// new fields can be added without inventing more keys.
export interface TerminalSettings {
  fontFamily: string
  fontSize: number
  lineHeight: number
  letterSpacing: number
  cursorStyle: "block" | "underline" | "bar"
  cursorBlink: boolean
  scrollback: number
  bellEnabled: boolean
  ligaturesEnabled: boolean
  webglEnabled: boolean
  themeName: TerminalThemeName
  // Auto-reconnect on an unexpected drop, with 1s/2s/4s backoff. The terminal
  // re-establishes a fresh session (the old SSH session died with the socket).
  autoReconnect: boolean
}

export const DEFAULT_TERMINAL_SETTINGS: TerminalSettings = {
  fontFamily:
    "'JetBrains Mono', 'Fira Code', ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, 'Liberation Mono', 'Courier New', monospace",
  fontSize: 14,
  lineHeight: 1.2,
  letterSpacing: 0,
  cursorStyle: "block",
  cursorBlink: true,
  scrollback: 5000,
  bellEnabled: false,
  ligaturesEnabled: true,
  webglEnabled: true,
  themeName: "system",
  autoReconnect: true,
}

export const FONT_SIZE_MIN = 10
export const FONT_SIZE_MAX = 22
export const SCROLLBACK_MIN = 1000
export const SCROLLBACK_MAX = 50000

const KEY = "webssh:settings:v2"
// Legacy single-purpose keys (kept around so old installs migrate cleanly).
const LEGACY_FONT_KEY = "webssh:fontSize"
const LEGACY_BELL_KEY = "webssh:bellEnabled"

function clampNumber(v: number, lo: number, hi: number, dflt: number): number {
  if (!Number.isFinite(v)) return dflt
  return Math.min(hi, Math.max(lo, v))
}

function loadFromLocalStorage(): TerminalSettings {
  if (typeof window === "undefined") return DEFAULT_TERMINAL_SETTINGS
  const raw = window.localStorage.getItem(KEY)
  if (raw) {
    try {
      const parsed = JSON.parse(raw) as Partial<TerminalSettings>
      return mergeWithDefaults(parsed)
    } catch {
      /* corrupt — fall through to legacy migration */
    }
  }
  // One-time migration from the pre-v2 single-purpose keys. After merging,
  // we don't remove the legacy keys — older clients that still read them
  // continue to see their values. The first save with the v2 key overwrites
  // whichever copy is freshest.
  const legacy: Partial<TerminalSettings> = {}
  const legacyFont = Number(window.localStorage.getItem(LEGACY_FONT_KEY))
  if (legacyFont >= FONT_SIZE_MIN && legacyFont <= FONT_SIZE_MAX) {
    legacy.fontSize = legacyFont
  }
  if (window.localStorage.getItem(LEGACY_BELL_KEY) === "1") {
    legacy.bellEnabled = true
  }
  return mergeWithDefaults(legacy)
}

function mergeWithDefaults(p: Partial<TerminalSettings>): TerminalSettings {
  return {
    ...DEFAULT_TERMINAL_SETTINGS,
    ...p,
    fontSize: clampNumber(
      p.fontSize ?? DEFAULT_TERMINAL_SETTINGS.fontSize,
      FONT_SIZE_MIN,
      FONT_SIZE_MAX,
      DEFAULT_TERMINAL_SETTINGS.fontSize,
    ),
    lineHeight: clampNumber(
      p.lineHeight ?? DEFAULT_TERMINAL_SETTINGS.lineHeight,
      1.0,
      1.8,
      DEFAULT_TERMINAL_SETTINGS.lineHeight,
    ),
    letterSpacing: clampNumber(
      p.letterSpacing ?? DEFAULT_TERMINAL_SETTINGS.letterSpacing,
      -2,
      4,
      DEFAULT_TERMINAL_SETTINGS.letterSpacing,
    ),
    scrollback: clampNumber(
      p.scrollback ?? DEFAULT_TERMINAL_SETTINGS.scrollback,
      SCROLLBACK_MIN,
      SCROLLBACK_MAX,
      DEFAULT_TERMINAL_SETTINGS.scrollback,
    ),
  }
}

export function useTerminalSettings() {
  const [settings, setSettings] = React.useState<TerminalSettings>(loadFromLocalStorage)

  React.useEffect(() => {
    if (typeof window === "undefined") return
    try {
      window.localStorage.setItem(KEY, JSON.stringify(settings))
    } catch {
      /* quota / disabled — surface silently, in-memory state still works */
    }
  }, [settings])

  const update = React.useCallback(
    (patch: Partial<TerminalSettings>) => setSettings((s) => ({ ...s, ...patch })),
    [],
  )

  const reset = React.useCallback(() => setSettings(DEFAULT_TERMINAL_SETTINGS), [])

  return { settings, update, reset } as const
}
