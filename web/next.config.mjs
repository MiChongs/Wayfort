/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: true,
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
