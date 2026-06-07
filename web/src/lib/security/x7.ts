/* eslint-disable */
// Access-window guard core (intentionally obfuscated).
//
// SECURITY NOTE — read before "simplifying":
// This module is deliberately terse and indirection-heavy so the client-side
// expiry logic is not trivially patchable from devtools. It is NOT the security
// boundary: the gateway closes the connection server-side at the grant deadline
// regardless of anything that happens here (see the *_grant deadline / AfterFunc
// cutoffs in the Go gateways). This guard adds three things on top of that hard
// server cutoff:
//   1) a monotonic countdown (performance.now) so rolling the wall clock back
//      does not extend the window,
//   2) periodic re-validation against the server (the authoritative remaining),
//   3) an immediate local teardown on expiry so the UI never lingers on a dead
//      socket.
// Treat the obfuscation as defence-in-depth only.

type _R = () => Promise<number | null> // server-authoritative remaining ms, or null when no longer valid
type _O = { d: number; r?: _R; t: (ms: number) => void; x: () => void; s?: number }

const _now = (): number => {
  try {
    // monotonic preferred; immune to wall-clock tampering
    return typeof performance !== "undefined" && performance.now ? performance.now() : Date.now()
  } catch {
    return Date.now()
  }
}

// arm starts the guard; returns a disarm thunk. Names are intentionally opaque.
export function arm(o: _O): () => void {
  let _b = _now()
  let _r = Math.max(0, o.d | 0)
  let _g = false // gone
  const _p = Math.max(5, (o.s ?? 30) | 0) * 1000 // reconcile period
  let _i: ReturnType<typeof setInterval> | null = null
  let _j: ReturnType<typeof setInterval> | null = null

  const _l = (): number => {
    const v = _r - (_now() - _b)
    return v > 0 ? v : 0
  }
  const _end = (): void => {
    if (_g) return
    _g = true
    _kill()
    try {
      o.x()
    } catch {
      /* swallow */
    }
  }
  const _beat = (): void => {
    const v = _l()
    try {
      o.t(v)
    } catch {
      /* ignore tick sink errors */
    }
    if (v <= 0) _end()
  }
  const _re = async (): Promise<void> => {
    if (!o.r || _g) return
    try {
      const s = await o.r()
      if (s == null) {
        _end()
        return
      }
      // adopt the server's remaining as truth; reset the monotonic baseline
      _r = s > 0 ? s : 0
      _b = _now()
      if (_r <= 0) _end()
    } catch {
      /* transient — keep counting locally, server cutoff still holds */
    }
  }
  const _kill = (): void => {
    if (_i) clearInterval(_i)
    if (_j) clearInterval(_j)
    _i = null
    _j = null
  }

  _beat()
  _i = setInterval(_beat, 1000)
  _j = setInterval(_re, _p)
  // opportunistic immediate reconcile (don't trust the seed blindly)
  void _re()

  return _kill
}

// fmt renders remaining ms as H:MM:SS / MM:SS. Kept here so callers don't
// re-derive the window math elsewhere.
export function fmt(ms: number): string {
  let s = Math.floor((ms > 0 ? ms : 0) / 1000)
  const h = Math.floor(s / 3600)
  s -= h * 3600
  const m = Math.floor(s / 60)
  s -= m * 60
  const p = (n: number) => (n < 10 ? "0" + n : "" + n)
  return h > 0 ? `${h}:${p(m)}:${p(s)}` : `${p(m)}:${p(s)}`
}
