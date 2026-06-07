"use client"

// 完全自定义的 Toast —— 严格遵循 DESIGN.md(项目根,warm-editorial 设计系统)。
// 用 sonner.toast.custom() 只借它的生命周期 / 定位 / 堆叠 / 进出,卡片本体由
// 下面这个 React 组件用 Tailwind 全权绘制。
//
// DESIGN.md 关键约束(刻意「去 SaaS / 去 AI 味」):
//   · 「color-block first, shadow rare」—— 系统里唯一的阴影是
//     0 1px 3px rgba(20,20,19,0.08),深度主要靠 hairline 边框 + 表面对比,而非
//     大模糊投影。所以卡片只有 1px 边框 + 一道极淡投影。
//   · 语义只用「小图标」承载,且用 DESIGN 的暖语义色(success #5db872 暖 sage、
//     warning #d4a017 琥珀金、error #c64545 暖砖红),不是饱和冷色,更不做整块
//     着色 / 左侧色条那种通用组件库套路。图标走 outline、无实色徽章底。
//   · coral(#cc785c)是唯一 brand voltage —— 只出现在 action 主按钮与 info/
//     loading 图标上,按下变暗到 #a9583e。
//   · 字号走 body/label 档,标题 weight 500(不是 600/粗体);圆角 lg/xl;
//     间距 4px 基准(px16 / py14 / gap12);focus 是 3px coral@15% 外环。
//
// API 与 sonner 的 toast 兼容:toast(msg,opts) / .success / .error / .warning /
// .info / .message / .loading / .promise / .custom / .dismiss,opts 支持
// { description, action, cancel, duration, id, closeButton, ... }。

import * as React from "react"
import {
  AlertTriangle,
  CircleCheck,
  CircleX,
  Info,
  Loader2,
  X,
} from "lucide-react"
import { toast as sonnerToast, type ExternalToast } from "sonner"
import { cn } from "@/lib/utils"

export type ToastTone = "success" | "error" | "warning" | "info" | "loading" | "default"

// 语气 → 图标 + 语义色(DESIGN.md 暖语义色;coral 用于 info/loading)。
// 颜色只施于 outline 图标这一处小元素,不染卡片。
const TONE: Record<
  ToastTone,
  {
    Glyph: React.ComponentType<{ className?: string; strokeWidth?: number }> | null
    color: string
  }
> = {
  success: { Glyph: CircleCheck, color: "text-[#5db872]" },
  error: { Glyph: CircleX, color: "text-[#c64545] dark:text-[#e06a6a]" },
  warning: { Glyph: AlertTriangle, color: "text-[#d4a017] dark:text-[#e3b84e]" },
  info: { Glyph: Info, color: "text-primary" },
  loading: { Glyph: Loader2, color: "text-primary" },
  default: { Glyph: null, color: "" },
}

export interface ToastAction {
  label: React.ReactNode
  onClick?: (event: React.MouseEvent<HTMLButtonElement>) => void
}

export interface ToastCardProps {
  id: string | number
  tone: ToastTone
  title: React.ReactNode
  description?: React.ReactNode
  action?: ToastAction
  cancel?: ToastAction
  closable?: boolean
}

export function ToastCard({
  id,
  tone,
  title,
  description,
  action,
  cancel,
  closable = true,
}: ToastCardProps) {
  const { Glyph, color } = TONE[tone]
  return (
    <div
      className={cn(
        // 卡片:popover 面 + hairline 边框 + DESIGN 唯一的那道极淡投影。
        // rounded-xl 贴 content-card 档;间距走 4px 基准(px16 / py14 / gap12)。
        "group/toast pointer-events-auto relative flex w-[356px] max-w-[86vw] items-start gap-3",
        "rounded-xl border border-border bg-popover px-4 py-3.5 font-sans text-popover-foreground",
        "shadow-[0_1px_3px_rgb(20_20_19/0.08)] dark:shadow-[0_2px_10px_rgb(0_0_0/0.35)]",
      )}
      role={tone === "error" || tone === "warning" ? "alert" : "status"}
      aria-live={tone === "error" ? "assertive" : "polite"}
    >
      {Glyph ? (
        <Glyph
          className={cn(
            "mt-px size-[18px] shrink-0",
            color,
            tone === "loading" && "animate-spin",
          )}
          strokeWidth={2}
        />
      ) : null}

      <div className={cn("flex min-w-0 flex-1 flex-col gap-0.5", !Glyph && "pl-0.5")}>
        <div
          className={cn(
            "text-sm font-medium leading-snug tracking-[-0.006em]",
            closable && "pr-5",
          )}
        >
          {title}
        </div>
        {description ? (
          <div className="break-words text-[13px] leading-relaxed text-muted-foreground">
            {description}
          </div>
        ) : null}

        {action || cancel ? (
          <div className="mt-2.5 flex items-center gap-2">
            {action ? (
              <button
                type="button"
                onClick={(e) => {
                  action.onClick?.(e)
                  sonnerToast.dismiss(id)
                }}
                className="inline-flex h-8 items-center rounded-md bg-primary px-3.5 text-[13px] font-medium text-primary-foreground transition-colors hover:bg-[#a9583e] active:bg-[#a9583e] focus-visible:outline-none focus-visible:ring-[3px] focus-visible:ring-primary/30"
              >
                {action.label}
              </button>
            ) : null}
            {cancel ? (
              <button
                type="button"
                onClick={(e) => {
                  cancel.onClick?.(e)
                  sonnerToast.dismiss(id)
                }}
                className="inline-flex h-8 items-center rounded-md border border-border bg-transparent px-3.5 text-[13px] font-medium text-foreground transition-colors hover:bg-accent focus-visible:outline-none focus-visible:ring-[3px] focus-visible:ring-primary/15"
              >
                {cancel.label}
              </button>
            ) : null}
          </div>
        ) : null}
      </div>

      {closable ? (
        <button
          type="button"
          onClick={() => sonnerToast.dismiss(id)}
          aria-label="关闭通知"
          className={cn(
            "absolute right-2 top-2.5 flex size-6 items-center justify-center rounded-md",
            // hover 只改图标色(DESIGN:除主按钮按下变暗外,hover 尽量不动其他);
            // 默认隐藏,悬停 / 聚焦浮现,触摸设备常驻微弱可见。
            "text-muted-foreground/55 transition-opacity duration-150 hover:text-foreground",
            "opacity-0 group-hover/toast:opacity-100 focus-visible:opacity-100 max-[600px]:opacity-60",
            "focus-visible:outline-none focus-visible:ring-[3px] focus-visible:ring-primary/15",
          )}
        >
          <X className="size-4" strokeWidth={2} />
        </button>
      ) : null}
    </div>
  )
}

// —— 人性化默认时长:错误停留更久(留时间读),成功一闪而过;loading 不自动消失 ——
const DURATION: Record<ToastTone, number> = {
  success: 3500,
  info: 4500,
  warning: 5500,
  error: 7000,
  loading: Infinity,
  default: 4500,
}

type ToastInput = React.ReactNode
export interface ToastOptions
  extends Omit<ExternalToast, "description" | "action" | "cancel"> {
  description?: React.ReactNode
  action?: ToastAction
  cancel?: ToastAction
}

function emit(tone: ToastTone, message: ToastInput, opts: ToastOptions = {}) {
  const { description, action, cancel, duration, closeButton, ...rest } = opts
  return sonnerToast.custom(
    (id) => (
      <ToastCard
        id={id}
        tone={tone}
        title={message}
        description={description}
        action={action}
        cancel={cancel}
        closable={closeButton !== false}
      />
    ),
    { duration: duration ?? DURATION[tone], ...rest },
  )
}

function resolve<T>(v: React.ReactNode | ((arg: T) => React.ReactNode), arg: T): React.ReactNode {
  return typeof v === "function" ? (v as (a: T) => React.ReactNode)(arg) : v
}

interface PromiseMessages<T> {
  loading: React.ReactNode
  success: React.ReactNode | ((data: T) => React.ReactNode)
  error: React.ReactNode | ((err: unknown) => React.ReactNode)
  description?: React.ReactNode
}

function promise<T>(input: Promise<T> | (() => Promise<T>), msgs: PromiseMessages<T>) {
  const id = emit("loading", msgs.loading, { duration: Infinity, description: msgs.description })
  const p = typeof input === "function" ? input() : input
  p.then(
    (data) => emit("success", resolve(msgs.success, data), { id, duration: DURATION.success }),
    (err) => emit("error", resolve(msgs.error, err), { id, duration: DURATION.error }),
  )
  return id
}

// 函数本体 = 默认(中性)toast;挂上各语气方法与透传方法,形态与 sonner 一致。
function baseToast(message: ToastInput, opts?: ToastOptions) {
  return emit("default", message, opts)
}

export const toast = Object.assign(baseToast, {
  success: (message: ToastInput, opts?: ToastOptions) => emit("success", message, opts),
  error: (message: ToastInput, opts?: ToastOptions) => emit("error", message, opts),
  warning: (message: ToastInput, opts?: ToastOptions) => emit("warning", message, opts),
  info: (message: ToastInput, opts?: ToastOptions) => emit("info", message, opts),
  message: (message: ToastInput, opts?: ToastOptions) => emit("default", message, opts),
  loading: (message: ToastInput, opts?: ToastOptions) =>
    emit("loading", message, { duration: Infinity, ...opts }),
  promise,
  custom: sonnerToast.custom,
  dismiss: (id?: string | number) => sonnerToast.dismiss(id),
  getHistory: () => sonnerToast.getHistory(),
  getToasts: () => sonnerToast.getToasts(),
})
