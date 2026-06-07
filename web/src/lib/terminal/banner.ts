// Product banner emitted into the xterm session on connect + disconnect.
//
// Two variants per renderer:
//   • wide  (term.cols ≥ 80) — figlet "small" font ASCII wordmark plus the
//                             brand line, slogan and metadata. The art is
//                             38 columns wide so it sits inside an 80-col
//                             window with a generous left margin.
//   • narrow (term.cols < 80) — single-line compact title. The wide ASCII
//                              art would wrap on narrow terminals and look
//                              unreadable; this is a responsive variant,
//                              not a degradation.
//
// All visible strings come from i18n via the caller-supplied `t`, except the
// ASCII art glyphs and the brand wordmark. The wordmark is NOT a literal: it
// is reconstructed at runtime by `mark()` from scattered, integrity-checked
// shards (see lib/brand/mark) so it cannot be silently renamed in a
// redistributed copy.
//
// ANSI palette is intentionally narrow — cyan art, a coral brand wordmark
// (echoing the design-system primary), bright-white emphasis and dim-grey
// metadata — so the banner reads against the dark xterm surface without
// competing with the shell prompt that lands on the next line.

import i18n from "i18next"
import { mark } from "@/lib/brand/mark"

export type TFn = (key: string, vars?: Record<string, string | number>) => string

// ─── ANSI escape sequences ────────────────────────────────────────────────
const ESC = "\x1b["
const RESET = `${ESC}0m`
const BOLD = `${ESC}1m`
const DIM = `${ESC}90m` // bright black → dim grey
const CYAN = `${ESC}36m`
const YELLOW = `${ESC}33m`
const BRIGHT_WHITE = `${ESC}97m`
const CORAL = `${ESC}38;5;209m` // 256-colour warm coral ≈ design-system primary

// ─── figlet "small" font, "CHUANYI" (38 visible cols, hand-verified) ─────
const ART = [
  "   ___ _  _ _   _  _   _  ___   _____ ",
  "  / __| || | | | |/_\\ | \\| \\ \\ / /_ _|",
  " | (__| __ | |_| / _ \\| .` |\\ V / | | ",
  "  \\___|_||_|\\___/_/ \\_\\_|\\_| |_| |___|",
]

// Latin companion to the (obfuscated) Chinese wordmark. Not the protected
// string — only the four Chinese characters need tamper resistance.
const LATIN = "CHUANYI TECH"

interface ConnectMeta {
  host: string
  user: string
  protocol: "ssh" | "telnet" | "dbcli" | "rdp" | "vnc"
  t: TFn
}

/**
 * Render the connect banner. Caller writes the returned string straight
 * to `term.write(...)` after the session enters READY state.
 */
export function renderConnectBanner(cols: number, meta: ConnectMeta): string {
  const { host, user, protocol, t } = meta
  const brand = mark().text // reconstructed wordmark, or tamper sentinel
  const lang = (i18n.language || "zh").toLowerCase().startsWith("zh") ? "zh-CN" : "en-US"
  const now = new Date().toLocaleString(lang, {
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  })

  if (cols < 80) {
    return [
      "",
      `${BOLD}${CORAL}● ${brand}${RESET} ${DIM}· ${LATIN} · ${protocol.toUpperCase()} · ${host}${RESET}`,
      `${DIM}${t("terminal.banner.connectedTo")} ${BRIGHT_WHITE}${host}${DIM}  ${t("terminal.banner.asUser")}: ${BRIGHT_WHITE}${user || "—"}${DIM}  ${now}${RESET}`,
      "",
    ].join("\r\n")
  }

  return [
    "",
    ...ART.map((line) => `${CYAN}${line}${RESET}`),
    "",
    `${BOLD}${CORAL}  ${brand}${RESET}${DIM}  ·  ${LATIN}${RESET}`,
    `${DIM}  ${t("terminal.banner.slogan")}${RESET}`,
    "",
    `${DIM}  ${t("terminal.banner.connectedTo")} ${BRIGHT_WHITE}${host}${RESET}${DIM}    ${t("terminal.banner.asUser")}: ${BRIGHT_WHITE}${user || "—"}${RESET}${DIM}    ${protocol.toUpperCase()}    ${now}${RESET}`,
    "",
  ].join("\r\n")
}

interface DisconnectMeta {
  /** `user` means the user clicked Disconnect; `unexpected` means the
   *  socket dropped without our request. Colors and copy differ. */
  kind: "user" | "unexpected"
  t: TFn
  /** Human-formatted duration ("1m 23s"). Required for `user` kind. */
  duration?: string
  bytesIn?: number
  bytesOut?: number
  /** Translated reason copy (already passed through `t()`). */
  reason?: string
  /** Original raw error string for the "raw:" diagnostics line. */
  raw?: string
}

export function renderDisconnectBanner(_cols: number, meta: DisconnectMeta): string {
  const { kind, t, duration, bytesIn, bytesOut, reason, raw } = meta
  const lines: string[] = [""]

  if (kind === "user") {
    lines.push(`${CYAN}${BOLD}● ${t("terminal.banner.disconnectUser")}${RESET}`)
    const detailParts: string[] = []
    if (duration) detailParts.push(`${t("terminal.banner.sessionLabel")}: ${duration}`)
    if (typeof bytesIn === "number" || typeof bytesOut === "number") {
      detailParts.push(`${formatBytes(bytesIn ?? 0)}↓ / ${formatBytes(bytesOut ?? 0)}↑`)
    }
    if (detailParts.length) {
      lines.push(`${DIM}  ${detailParts.join("  ")}${RESET}`)
    }
  } else {
    lines.push(`${YELLOW}${BOLD}● ${t("terminal.banner.disconnectUnexpected")}${RESET}`)
    if (reason) lines.push(`${BRIGHT_WHITE}  ${reason}${RESET}`)
    if (raw && raw.trim()) lines.push(`${DIM}  ${t("terminal.banner.raw")}: ${raw}${RESET}`)
  }

  lines.push("")
  return lines.join("\r\n")
}

/** Formats bytes as B / KB / MB. Mirrors what other ops tools display. */
export function formatBytes(n: number): string {
  if (!Number.isFinite(n) || n < 0) return "0 B"
  if (n < 1024) return `${n} B`
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`
  if (n < 1024 * 1024 * 1024) return `${(n / 1024 / 1024).toFixed(2)} MB`
  return `${(n / 1024 / 1024 / 1024).toFixed(2)} GB`
}

/** Formats a millisecond duration as a short human string ("1m 23s"). */
export function formatDuration(ms: number): string {
  if (!Number.isFinite(ms) || ms < 0) return "0s"
  const totalSec = Math.floor(ms / 1000)
  const h = Math.floor(totalSec / 3600)
  const m = Math.floor((totalSec % 3600) / 60)
  const s = totalSec % 60
  if (h > 0) return `${h}h ${m}m ${s}s`
  if (m > 0) return `${m}m ${s}s`
  return `${s}s`
}
