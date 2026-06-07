import type { Metadata } from "next"
import { Geist, Geist_Mono, Cormorant_Garamond } from "next/font/google"
import "./globals.css"
import { Providers } from "@/components/providers"

// Vercel-grade humanist sans for all body / UI copy — high x-height, precise
// hinting at small sizes. Replaces the previous system-font stack.
const geistSans = Geist({
  subsets: ["latin"],
  variable: "--font-geist-sans",
  display: "swap",
})

// Geist Mono — code blocks, terminals, monospace tokens.
const geistMono = Geist_Mono({
  subsets: ["latin"],
  variable: "--font-geist-mono",
  display: "swap",
})

// Cormorant Garamond — the editorial serif display face (Copernicus / Tiempos
// substitute per DESIGN.md). Used on large headlines at weight 500 with the
// negative tracking applied via the `.font-display` utility in globals.css.
const cormorant = Cormorant_Garamond({
  subsets: ["latin"],
  weight: ["400", "500", "600"],
  variable: "--font-cormorant",
  display: "swap",
})

export const metadata: Metadata = {
  title: "JumpServer Anonymous",
  description: "现代化网页跳板机 + 多协议网关 + AI 运维助手",
}

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html
      lang="zh-CN"
      suppressHydrationWarning
      className={`${geistSans.variable} ${geistMono.variable} ${cormorant.variable}`}
    >
      <body className="font-sans antialiased min-h-screen bg-background text-foreground">
        <Providers>{children}</Providers>
      </body>
    </html>
  )
}
