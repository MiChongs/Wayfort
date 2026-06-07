"use client"

import * as React from "react"
import type { DesktopSettings } from "./desktop-types"

export const DEFAULT_DESKTOP_SETTINGS: DesktopSettings = {
  scaleMode: "fit",
  dynamicResolution: false,
  videoTransport: "auto",
  videoQuality: "balanced",
  preferredWidth: 1280,
  preferredHeight: 720,
  colorDepth: 32,
  smoothScaling: true,
  highDpi: true,
  dpiScale: "auto",
  keyboardLayout: "us",
  syncLocks: true,
  swapMiddleButton: false,
  clipboardDirection: "both",
  clipboardConfirmLines: 2,
  audioPlayback: true,
  cursorMode: "remote",
  reconnectOnDrop: true,
}

const KEY = "desktop:settings:v1"

function loadFromLocalStorage(): DesktopSettings {
  if (typeof window === "undefined") return DEFAULT_DESKTOP_SETTINGS
  const raw = window.localStorage.getItem(KEY)
  if (!raw) return DEFAULT_DESKTOP_SETTINGS
  try {
    const parsed = JSON.parse(raw) as Partial<DesktopSettings>
    return { ...DEFAULT_DESKTOP_SETTINGS, ...parsed }
  } catch {
    return DEFAULT_DESKTOP_SETTINGS
  }
}

export function useDesktopSettings() {
  const [settings, setSettings] = React.useState<DesktopSettings>(loadFromLocalStorage)

  React.useEffect(() => {
    if (typeof window === "undefined") return
    try {
      window.localStorage.setItem(KEY, JSON.stringify(settings))
    } catch {
      /* quota / disabled — in-memory state still works */
    }
  }, [settings])

  const update = React.useCallback(
    (patch: Partial<DesktopSettings>) => setSettings((s) => ({ ...s, ...patch })),
    [],
  )
  const reset = React.useCallback(() => setSettings(DEFAULT_DESKTOP_SETTINGS), [])

  return { settings, update, reset } as const
}

// effectiveDpiScale resolves the high-DPI setting to a concrete percentage the
// gateway applies to the remote desktop. "auto" follows the browser's
// devicePixelRatio (snapped to 25% steps, clamped 100–300); off = 100.
export function effectiveDpiScale(s: Pick<DesktopSettings, "highDpi" | "dpiScale">): number {
  if (!s.highDpi) return 100
  if (s.dpiScale !== "auto") {
    const n = parseInt(s.dpiScale, 10)
    return Number.isFinite(n) ? n : 100
  }
  const dpr = typeof window !== "undefined" ? window.devicePixelRatio || 1 : 1
  const pct = Math.round((dpr * 100) / 25) * 25
  return Math.max(100, Math.min(300, pct))
}

export const KEYBOARD_LAYOUTS: ReadonlyArray<{ value: string; label: string }> = [
  { value: "us", label: "US / 美式" },
  { value: "uk", label: "UK / 英式" },
  { value: "de", label: "DE / 德式" },
  { value: "fr", label: "FR / 法式" },
  { value: "es", label: "ES / 西式" },
  { value: "it", label: "IT / 意式" },
  { value: "ja", label: "JA / 日式" },
  { value: "ko", label: "KO / 韩式" },
  { value: "zh", label: "ZH / 中文" },
  { value: "ru", label: "RU / 俄式" },
]
