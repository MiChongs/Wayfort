/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: true,
  // The backend lives on a separate origin during dev; we proxy /api/* through
  // a Route Handler (see src/app/api/proxy/[...path]/route.ts) so the browser
  // sees a same-origin URL and there's no CORS dance.
  experimental: {
    typedRoutes: false,
  },
  // Long-running SSE responses must not be statically optimised.
  async headers() {
    return [
      {
        source: '/api/proxy/:path*',
        headers: [
          { key: 'X-Accel-Buffering', value: 'no' },
        ],
      },
    ]
  },
}
export default nextConfig
