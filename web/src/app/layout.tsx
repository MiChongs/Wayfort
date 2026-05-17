import type { Metadata } from "next"
import "./globals.css"
import { Providers } from "@/components/providers"

export const metadata: Metadata = {
  title: "JumpServer Anonymous",
  description: "现代化网页跳板机 + 多协议网关 + AI 运维助手",
}

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="zh-CN" suppressHydrationWarning>
      <body className="font-sans antialiased min-h-screen bg-background text-foreground">
        <Providers>{children}</Providers>
      </body>
    </html>
  )
}
