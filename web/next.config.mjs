/** @type {import('next').NextConfig} */
const nextConfig = {
  // reactStrictMode is OFF for this app because the workspace v2 lifecycle
  // (rdp_next desktop, terminal v2, sftp) opens long-lived WebSockets and
  // spawns gateway-side worker subprocesses on mount. React 19 dev's
  // double-invoke of `useEffect` (visible in console stacks as
  // `doubleInvokeEffectsOnFiber`) tears those down before the connect
  // completes and re-runs setup, which (a) orphans worker subprocesses
  // on the gateway (every dev mount leaks one `freerdp-worker.exe`) and
  // (b) makes the picture flash "出现了一下就掉" in the rdp_next viewer.
  //
  // PR #27 added a module-level LiveCache + 200ms deferred teardown to
  // survive double-invoke without re-issuing POST /start, but empirically
  // a Path B (cache-miss) cleanup still fired synchronously with a
  // populated session (bytesIn=34628, sessionId set) — meaning either
  // the cache wasn't yet populated at cleanup time (race with async
  // POST), or a non-StrictMode unmount path is reaching the fallback.
  // Disabling strictMode globally is the surest cure; the bug-detection
  // value it gives is outweighed by the rdp_next dev experience being
  // broken. Re-enable once every workspace protocol has a fully audited
  // resource-survive-double-invoke pattern (orthogonal future cleanup).
  reactStrictMode: false,
  // typedRoutes lifted out of experimental in Next.js 16; we keep it off for
  // now since `Parameters<typeof Link>[0]["href"]` casts cover the dynamic
  // routes (sessions/[id], nodes/[id]/ssh) end to end.
  typedRoutes: false,
  async headers() {
    return [
      {
        source: "/api/proxy/:path*",
        headers: [{ key: "X-Accel-Buffering", value: "no" }],
      },
    ]
  },
}
export default nextConfig
