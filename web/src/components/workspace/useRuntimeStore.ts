import { create } from "zustand"

// Runtime (non-persisted) workspace state. These fields churn every second
// (latency RTT) or are pure session ephemera (expiry countdown, renewal
// target, the dock→terminal command bridge). Keeping them OUT of the
// persisted store means a latency tick no longer creates a new `tabs` array,
// so the tab strip / content area / session bodies don't re-render on every
// RTT sample — only the small latency badge that subscribes to its own key.

// Per-tab approval-grant countdown published by ExpiryGuard, read by the
// status bar. Dies with the session, never persisted.
export type ExpiryInfo = { ms: number; deadline: string; low: boolean }

type PendingCmd = { text: string; run: boolean; nonce: number }

type RuntimeState = {
  // Live round-trip latency per tab. `null` = unmeasurable on this transport
  // (renders as a dash); an absent key = never reported yet (badge hidden).
  latency: Record<string, number | null>
  expiry: Record<string, ExpiryInfo>
  // tabId whose renewal dialog should open — set by the status bar's "续期"
  // button, consumed by that tab's ExpiryGuard.
  renewTarget: string | null
  // dock → terminal command bridge. The ops dock writes a command here for a
  // given tab; that tab's live WebSSH terminal drains it (sendInput) once the
  // session is ready, then clears it by nonce.
  pendingCmd: Record<string, PendingCmd>
}

type RuntimeActions = {
  // `null` = unmeasurable; the badge then shows a dash instead of hiding.
  setLatency: (id: string, latencyMs: number | null) => void
  setExpiry: (id: string, info: ExpiryInfo | null) => void
  requestRenew: (id: string | null) => void
  sendToTerminal: (tabId: string, text: string, run?: boolean) => void
  consumePendingCmd: (tabId: string, nonce: number) => void
}

export type RuntimeStore = RuntimeState & RuntimeActions

export const useRuntimeStore = create<RuntimeStore>((set) => ({
  latency: {},
  expiry: {},
  renewTarget: null,
  pendingCmd: {},

  setLatency: (id, latencyMs) =>
    set((s) => {
      // Idempotent: identical sample doesn't churn the map reference.
      if (s.latency[id] === latencyMs) return s
      return { latency: { ...s.latency, [id]: latencyMs } }
    }),

  setExpiry: (id, info) =>
    set((s) => {
      const next = { ...s.expiry }
      if (info == null) delete next[id]
      else next[id] = info
      return { expiry: next }
    }),

  requestRenew: (id) => set({ renewTarget: id }),

  // `run` appends a newline so the shell executes it; otherwise it's only typed
  // at the prompt for the user to review and press Enter.
  sendToTerminal: (tabId, text, run = true) =>
    set((s) => ({
      pendingCmd: {
        ...s.pendingCmd,
        [tabId]: { text, run, nonce: Date.now() + Math.floor(Math.random() * 1000) },
      },
    })),

  consumePendingCmd: (tabId, nonce) =>
    set((s) => {
      const cur = s.pendingCmd[tabId]
      if (!cur || cur.nonce !== nonce) return {}
      const next = { ...s.pendingCmd }
      delete next[tabId]
      return { pendingCmd: next }
    }),
}))
