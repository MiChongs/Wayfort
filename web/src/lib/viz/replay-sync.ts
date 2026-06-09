// ReplayController is the protocol-neutral contract that lets the terminal
// (asciinema) and desktop (.dtr) players expose the same playback surface, so a
// single <SyncedTimeline> can drive either: highlight the active audit row as
// the clock advances, and seek the player when a row is clicked.

export interface ReplayController {
  /** Total recording length in ms. */
  durationMs(): number
  /** Current playhead position in ms. */
  getCurrentMs(): number
  /** Move the playhead. */
  seekMs(ms: number): void
  play(): void
  pause(): void
  isPlaying(): boolean
  /** Subscribe to throttled clock ticks; returns an unsubscribe fn. */
  onTime(cb: (ms: number) => void): () => void
  /** Subscribe to play/pause changes; returns an unsubscribe fn. */
  onPlayState(cb: (playing: boolean) => void): () => void
}

// eventOffsetMs converts a wall-clock audit timestamp into an offset from the
// recording's zero point (the session start), clamped to [0, duration]. Events
// produced before the recording's first frame (e.g. during handshake) clamp to
// 0; ones after the end clamp to the end.
export function eventOffsetMs(
  createdAtISO: string,
  sessionStartISO: string,
  durationMs: number,
): number {
  const t = new Date(createdAtISO).getTime() - new Date(sessionStartISO).getTime()
  if (Number.isNaN(t)) return 0
  if (t < 0) return 0
  if (durationMs > 0 && t > durationMs) return durationMs
  return t
}

// fmtClock renders an ms offset as m:ss (or h:mm:ss past an hour) for scrubber
// ticks and timeline rows.
export function fmtClock(ms: number): string {
  const total = Math.max(0, Math.floor(ms / 1000))
  const h = Math.floor(total / 3600)
  const m = Math.floor((total % 3600) / 60)
  const s = total % 60
  const pad = (n: number) => String(n).padStart(2, "0")
  return h > 0 ? `${h}:${pad(m)}:${pad(s)}` : `${m}:${pad(s)}`
}
