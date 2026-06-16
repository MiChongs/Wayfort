"use client"

// 全局启动动画 —— Wayfort「SecureLink」品牌引导动画。
//
// 设计意图(对标多协议运维网关 / 跳板机的「建立可信链路」):
//   珊瑚色 SpikeMark 方块落位 → 8 芒星射线沿 pathLength 逐笔「绘制」(链路协商)
//   → 一道珊瑚扫描线单次掠过标记(仪器绘制) → 一圈珊瑚信号环外扩淡出(握手 ACK)
//   → Geist 字标「Wayfort」逐字遮罩上浮揭示(闸门开启) → 居中生长的发丝基线
//   → 衬线副标 + 中文标语落定 → 全幅上提淡出,露出底层应用。
//
// 设计系统铁律(务必保持,勿在后续编辑中破坏):
//   · 暖底:整屏仅 bg-background 一种主题面(浅 #faf9f5 / 深 #181715),无渐变。
//   · 珊瑚稀缺:珊瑚(--primary)只出现在「3 个表面」——标记方块填充 / 扫描线 /
//     信号环。再多一处(网格 / 粒子 / 第二个环 / 光晕)即破坏品牌电压,禁止新增。
//   · 字标用 Geist 无衬线 semibold(项目铁律,绝不用衬线);Cormorant 衬线仅用于
//     拉丁副标这一处装饰,且中文标语必须用 Geist(Cormorant 无中文字形)。
//   · 仅动画 transform / opacity / filter 与 SVG pathLength,杜绝布局抖动。
//   · 「阴影克制」——景深来自色块对比,而非投影。
//
// 持久化:每个浏览器会话仅展示一次(sessionStorage 标记)。会话内刷新 / SPA 跳转
//   不重复;浏览器完全关闭后再打开 → 会话存储清空 → 重新展示(契合「每次重新打开
//   浏览器后显示」)。SSR / 水合安全:服务端与首帧客户端均渲染 null,由客户端 effect
//   读取会话存储后决定展示;切勿在渲染期读 sessionStorage(否则水合不一致)。
//
// 抗闪烁:layout.tsx 的预水合内联脚本会在标记缺失时给 <html> 打上 data-splash-pending,
//   配合 globals.css 的 ::before 在 React 接管前就铺满 bg-background;本组件挂载后在
//   下一帧移除该属性(此时 z-[9999] 遮罩已就位),内联脚本另有 5s 兜底移除。

import * as React from "react"
import { motion, useReducedMotion } from "motion/react"

const SPLASH_KEY = "wayfort:splash:v1" // 版本化:未来改版可一次性重新触发
const EASE = [0.22, 1, 0.36, 1] as const
const INTRO_MS = 2300 // 完整动画从挂载到「开始退场」的时长
const REDUCED_MS = 620 // 偏好减少动效时的极简时长

// SpikeMark 字形(逐字节复用 app-shell/sidebar.tsx 的品牌标记):8 芒星拆成 4 段子笔画
// (竖 / 横 / 两条对角),逐段 pathLength 描绘,呈现「被仪器绘制」的工程质感。
const SPOKES = ["M12 3v18", "M3 12h18", "M5.6 5.6l12.8 12.8", "M18.4 5.6 5.6 18.4"]

const WORDMARK = "Wayfort".split("")

type Phase = "pending" | "intro" | "exit" | "gone"

export function SplashScreen() {
  const reduce = useReducedMotion()
  // pending:服务端 + 首帧客户端(渲染 null,水合安全);gone:已展示过 / 退场完成。
  const [phase, setPhase] = React.useState<Phase>("pending")

  React.useEffect(() => {
    let seen = false
    try {
      seen = sessionStorage.getItem(SPLASH_KEY) != null
    } catch {
      // 隐私模式 / 禁用存储:降级为「本次展示且不再追踪」。
    }
    if (seen) {
      // 本会话已展示过 —— 顺手清掉可能残留的预水合遮罩,直接隐身。
      try {
        document.documentElement.removeAttribute("data-splash-pending")
      } catch {}
      setPhase("gone")
      return
    }
    // 在「决定展示」的此刻即写入标记(而非退场时),确保动画途中刷新 / 跳转不会重播。
    try {
      sessionStorage.setItem(SPLASH_KEY, "1")
    } catch {}
    setPhase("intro")

    // 下一帧:z-[9999] 遮罩已提交上屏,移除预水合静态遮罩,避免任何一帧穿透。
    const raf = requestAnimationFrame(() => {
      try {
        document.documentElement.removeAttribute("data-splash-pending")
      } catch {}
    })
    const introMs = reduce ? REDUCED_MS : INTRO_MS
    const timer = window.setTimeout(() => setPhase("exit"), introMs)
    return () => {
      cancelAnimationFrame(raf)
      window.clearTimeout(timer)
    }
  }, [reduce])

  if (phase === "pending" || phase === "gone") return null

  const exiting = phase === "exit"

  return (
    <motion.div
      className="fixed inset-0 z-[9999] flex items-center justify-center overflow-hidden bg-background"
      initial={false}
      animate={
        exiting
          ? reduce
            ? { opacity: 0 }
            : { opacity: 0, scale: 1.04, y: -8 }
          : { opacity: 1, scale: 1, y: 0 }
      }
      transition={exiting ? { duration: reduce ? 0.3 : 0.5, ease: EASE } : { duration: 0 }}
      onAnimationComplete={() => {
        if (phase === "exit") setPhase("gone")
      }}
      style={{ pointerEvents: exiting ? "none" : "auto" }}
      role="status"
    >
      {/* 读屏器只播报这一句礼貌状态;下方整组视觉为装饰,统一 aria-hidden,
          避免逐字母念出「W-a-y-f-o-r-t」及重复念标语。 */}
      <span className="sr-only">正在启动 Wayfort</span>
      <div aria-hidden className="relative flex flex-col items-center">
        {/* ——— 标记舞台:信号环 / 扫描线 / 珊瑚方块 ——— */}
        {/* 舞台比方块更宽,让扫描线有可见的横向余幅:线掠过方块时中段被方块遮挡、
            两侧露出,呈现「被标记吸收 / 处理」的仪器感。 */}
        <div className="relative flex h-[92px] w-[132px] items-center justify-center">
          {/* 握手 ACK 信号环(珊瑚 · 表面 3 之一)——单次外扩淡出 */}
          {!reduce && (
            <motion.span
              aria-hidden
              className="pointer-events-none absolute h-14 w-14 rounded-full border-[1.5px] border-primary"
              initial={{ scale: 0.8, opacity: 0.55 }}
              animate={{ scale: 2.3, opacity: 0 }}
              transition={{ delay: 1.1, duration: 0.7, ease: EASE }}
            />
          )}

          {/* 扫描线(珊瑚 · 表面 3 之二)——单次自上而下掠过,过中点最亮、首尾淡出不滞留。
              用关键帧数组,故 initial 必须给定具体起始帧(给 false 会被当作「已在终帧」跳过)。 */}
          {!reduce && (
            <span aria-hidden className="pointer-events-none absolute inset-0 overflow-hidden">
              <motion.span
                className="absolute inset-x-0 h-px bg-primary"
                initial={{ y: -52, opacity: 0 }}
                animate={{ y: [-52, 0, 52], opacity: [0, 0.75, 0] }}
                transition={{ delay: 0.42, duration: 0.62, ease: EASE, times: [0, 0.5, 1] }}
              />
            </span>
          )}

          {/* 珊瑚 SpikeMark 方块(珊瑚 · 表面 3 之三)——落位 + 射线逐笔描绘 */}
          <motion.div
            className="relative flex h-14 w-14 items-center justify-center rounded-[16px] bg-primary text-primary-foreground"
            initial={reduce ? false : { scale: 0.86, opacity: 0 }}
            animate={{ scale: 1, opacity: 1 }}
            transition={{ delay: 0.1, duration: 0.34, ease: EASE }}
          >
            <svg
              viewBox="0 0 24 24"
              className="h-7 w-7"
              fill="none"
              stroke="currentColor"
              strokeWidth={2.4}
              strokeLinecap="round"
              aria-hidden
            >
              {SPOKES.map((d, i) => (
                <motion.path
                  key={d}
                  d={d}
                  initial={reduce ? false : { pathLength: 0, opacity: 0 }}
                  animate={{ pathLength: 1, opacity: 1 }}
                  transition={{ delay: 0.38 + i * 0.04, duration: 0.36, ease: EASE }}
                />
              ))}
            </svg>
          </motion.div>
        </div>

        {/* ——— 字标「Wayfort」:逐字 上浮 + 去模糊 + 淡入(Geist semibold,绝不衬线)——— */}
        <div className="mt-6 flex text-3xl font-semibold tracking-tight text-foreground">
          {WORDMARK.map((ch, i) => (
            <motion.span
              key={i}
              initial={reduce ? false : { y: 14, opacity: 0, filter: "blur(6px)" }}
              animate={{ y: 0, opacity: 1, filter: "blur(0px)" }}
              transition={{ delay: 1.2 + i * 0.028, duration: 0.48, ease: EASE }}
            >
              {ch}
            </motion.span>
          ))}
        </div>

        {/* ——— 发丝基线:自中心横向生长(border 色 · 非珊瑚 · 色块景深)——— */}
        <motion.div
          aria-hidden
          className="mt-4 h-px w-28 origin-center bg-border"
          initial={reduce ? false : { scaleX: 0, opacity: 0 }}
          animate={{ scaleX: 1, opacity: 1 }}
          transition={{ delay: 1.28, duration: 0.42, ease: EASE }}
        />

        {/* ——— 标语:中文(Geist)+ 拉丁衬线副标(Cormorant,唯一一处衬线)——— */}
        <motion.div
          className="mt-3 flex flex-col items-center gap-1 text-center"
          initial={reduce ? false : { y: 6, opacity: 0 }}
          animate={{ y: 0, opacity: 1 }}
          transition={{ delay: 1.52, duration: 0.36, ease: EASE }}
        >
          <span className="text-xs tracking-[0.14em] text-muted-foreground">多协议运维网关</span>
          <span className="display-title text-[12px] tracking-[0.06em] text-muted-foreground/75">
            Multi-Protocol Ops Gateway
          </span>
        </motion.div>
      </div>
    </motion.div>
  )
}
