// Auth shell — Anthropic-style dark minimal surface.
//
// 设计取自 Claude 官网:近黑暖色画布、克制留白、贯穿的发丝分隔线、珊瑚色品牌
// 标记。刻意去掉旧版左侧的营销 brand 面板(4 张特性卡 + 大段文案)—— 登录页
// 只需要一个登录入口,不堆砌描述。
//
// 强制 .dark:不论系统主题,登录始终是图里的暖色深底。其余 app 仍跟随 next-themes。
// 纪律:标题用 Geist(非衬线,见项目铁律),不用 .display-title。

import { ArrowUpRight } from "lucide-react"
import { Button } from "@/components/ui/button"

export default function AuthLayout({ children }: { children: React.ReactNode }) {
  return (
    <div className="dark h-full overflow-y-auto bg-background text-foreground">
      <div className="flex min-h-full flex-col">
        {/* Top bar — 品牌标记 + 沙箱入口(对应图里的 "Try Claude" 胶囊) */}
        <header className="flex items-center justify-between gap-4 px-5 py-4 sm:px-8">
          <a href="/login" className="flex items-center gap-2.5 outline-none">
            <BurstMark className="h-6 w-6 shrink-0 text-primary" />
            <span className="text-[15px] font-semibold tracking-tight">Wayfort</span>
          </a>
          <Button variant="outline" size="sm" asChild className="rounded-full">
            <a href="/sandbox">
              体验沙箱
              <ArrowUpRight className="h-3.5 w-3.5" />
            </a>
          </Button>
        </header>

        <div className="border-t border-border" />

        {/* 登录内容 — 居中、留白充足 */}
        <main className="flex flex-1 items-center justify-center px-5 py-12 sm:px-8">
          <div className="w-full max-w-sm">{children}</div>
        </main>

        <div className="border-t border-border" />

        <footer className="flex flex-wrap items-center justify-between gap-x-4 gap-y-1 px-5 py-4 text-[11px] text-muted-foreground sm:px-8">
          <span>© Wayfort · Open Source</span>
          <span className="tracking-wide">Bastion · 远程访问网关</span>
        </footer>
      </div>
    </div>
  )
}

// 珊瑚色放射标记 —— 呼应图里的星芒,但用均匀的 12 道胶囊光线,与原 logo 区分。
function BurstMark({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 24 24" fill="currentColor" aria-hidden className={className}>
      {Array.from({ length: 12 }).map((_, i) => (
        <rect
          key={i}
          x="11.1"
          y="2.4"
          width="1.8"
          height="7"
          rx="0.9"
          transform={`rotate(${i * 30} 12 12)`}
        />
      ))}
    </svg>
  )
}
