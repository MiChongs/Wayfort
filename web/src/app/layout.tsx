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
  title: "Wayfort",
  description: "现代化网页跳板机 + 多协议网关 + AI 运维助手",
  // Point the icon at the bundled SVG so browsers use it instead of probing the
  // non-existent /favicon.ico (which 404s on every page load).
  icons: { icon: "/favicon.svg", shortcut: "/favicon.svg" },
}

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html
      lang="zh-CN"
      suppressHydrationWarning
      className={`h-full ${geistSans.variable} ${geistMono.variable} ${cormorant.variable}`}
    >
      {/* Lock the document to exactly the viewport so no Provider-level sibling
          (toasts / dev tools / overlays) can grow the body and body-scroll into
          blank space below the route shell. Each route group owns its own scroll
          (app: main; workspace: internal; auth: overflow-y-auto). Fixed-position
          elements escape this overflow, so toasts/dialogs still render. */}
      <body className="font-sans antialiased h-full overflow-hidden bg-background text-foreground">
        {/* 启动动画抗闪烁:预水合内联脚本——若本会话尚未展示过启动动画,在 React 接管前
            就给 <html> 打上 data-splash-pending,由 globals.css 的 ::before 立刻铺满
            bg-background,杜绝冷启动时底层应用闪现。SplashScreen 挂载后下一帧移除该属性;
            脚本另设 5s 兜底移除,确保任何异常下都不会永久遮挡。see splash-screen.tsx */}
        <script
          dangerouslySetInnerHTML={{
            __html:
              "(function(){try{var k='wayfort:splash:v1';if(!sessionStorage.getItem(k)){var e=document.documentElement;e.setAttribute('data-splash-pending','');setTimeout(function(){e.removeAttribute('data-splash-pending')},5000);}}catch(e){}})();",
          }}
        />
        <Providers>{children}</Providers>
      </body>
    </html>
  )
}
