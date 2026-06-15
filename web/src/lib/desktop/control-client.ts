// Plan 17 control-plane client. Today it's a thin REST wrapper around
// /api/v1/desktop/sessions; M1.5 swaps it for a ConnectRPC client over
// the same path namespace.

import { api } from "@/lib/api/client"
import type { DesktopStats, StartSessionRequest, StartSessionResponse } from "./types"

export const desktopControl = {
  startSession: (req: StartSessionRequest) =>
    api<StartSessionResponse>("POST", "/desktop/sessions", { body: req }),
  endSession: (sessionId: string) =>
    api<{ ok: boolean }>("DELETE", `/desktop/sessions/${sessionId}`),
  // Backend/worker/gateway readiness — drives the default RDP backend choice.
  stats: () => api<DesktopStats>("GET", "/desktop/stats"),
}
