"use client"

// 匿名 Docker 沙箱控制台。
//
// 一次性、无需注册的隔离 shell:点击「启动沙箱」→ 后端 mint 一个匿名 JWT 并
// 起一个加固容器(只读根 / 断网 / no-new-privileges / 资源上限)→ 复用与节点
// 会话同一套 WebSSHTerminal 接入容器 exec 流 → TTL 到期后端硬切断并自动销毁。
//
// 设计:暖色系,不喊「AI」;落地页诚实展示真实资源规格与安全边界;终端铺满。
// token 只活在内存里(传给 WebSSHTerminal 的 wsToken),绝不写 localStorage,
// 因此既不要求登录、也不会污染管理员已登录的会话。

import * as React from "react"
import Link from "next/link"
import dynamic from "next/dynamic"
import { useQuery } from "@tanstack/react-query"
import { AnimatePresence, motion, useReducedMotion } from "motion/react"
import {
  ArrowRight,
  Box,
  Cpu,
  Gauge,
  Loader2,
  LogIn,
  MemoryStick,
  Network,
  RotateCcw,
  ShieldCheck,
  Terminal as TerminalIcon,
  Timer,
  TriangleAlert,
  Zap,
} from "lucide-react"
import { Button } from "@/components/ui/button"
import { Badge } from "@/components/ui/badge"
import { toast } from "@/components/ui/sonner"
import { authService } from "@/lib/api/services"
import type { AnonymousSession, SandboxSpec } from "@/lib/api/types"
import type { Status } from "@/components/terminal/webssh-terminal"
import { cn } from "@/lib/utils"

// The terminal pulls in xterm + a pile of addons; keep it out of the landing
// bundle and only load it once a sandbox is actually launched.
const WebSSHTerminal = dynamic(
  () => import("@/components/terminal/webssh-terminal").then((m) => m.WebSSHTerminal),
  { ssr: false },
)

type Phase = "intro" | "launching" | "live" | "ended"

export function SandboxConsole() {
  const reduced = useReducedMotion()
  const [phase, setPhase] = React.useState<Phase>("intro")
  const [session, setSession] = React.useState<AnonymousSession | null>(null)
  const [launchedAt, setLaunchedAt] = React.useState(0)
  const [endReason, setEndReason] = React.useState<string>("")

  // Probe the spec without minting a token so the landing shows real numbers
  // and a friendly disabled state.
  const info = useQuery({
    queryKey: ["sandbox", "info"],
    queryFn: authService.sandboxInfo,
    staleTime: 60_000,
  })

  const launch = React.useCallback(async () => {
    setPhase("launching")
    setEndReason("")
    try {
      const s = await authService.anonymous()
      setSession(s)
      setLaunchedAt(Date.now())
      setPhase("live")
    } catch (e: unknown) {
      const err = e as { status?: number; message?: string }
      const msg =
        err.status === 403
          ? "管理员尚未开启匿名沙箱功能"
          : err.message || "无法启动沙箱,请稍后重试"
      toast.error("启动失败", { description: msg })
      setPhase("intro")
      info.refetch()
    }
  }, [info])

  // The terminal owns the live connection; when it drops (user disconnect,
  // error, or the server's TTL cutoff) we move to the ended panel. Sandbox mode
  // disables auto-reconnect, so a drop is always terminal. The server enforces
  // the cutoff a hair after the countdown hits zero and reports it as a socket
  // error — recognise that window so an expected expiry doesn't read as a fault.
  const onStatusChange = React.useCallback(
    (status: Status) => {
      if (status !== "closed" && status !== "error") return
      const expired =
        launchedAt > 0 &&
        !!session &&
        Date.now() >= launchedAt + session.sandbox.ttl_seconds * 1000 - 3000
      setPhase((p) => (p === "live" ? "ended" : p))
      setEndReason(
        expired
          ? "沙箱已到期,容器已自动销毁"
          : status === "error"
            ? "连接已中断"
            : "你结束了本次会话",
      )
    },
    [launchedAt, session],
  )

  return (
    <div className="relative flex h-full w-full flex-col">
      <AnimatePresence mode="wait">
        {phase === "intro" && (
          <motion.div
            key="intro"
            initial={reduced ? false : { opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={reduced ? undefined : { opacity: 0 }}
            className="flex-1 overflow-y-auto"
          >
            <SandboxIntro
              spec={info.data?.sandbox}
              enabled={info.data?.enabled ?? true}
              loading={info.isLoading}
              onLaunch={launch}
            />
          </motion.div>
        )}

        {phase === "launching" && (
          <motion.div
            key="launching"
            initial={reduced ? false : { opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={reduced ? undefined : { opacity: 0 }}
            className="flex flex-1 items-center justify-center"
          >
            <div className="flex flex-col items-center gap-4 text-center">
              <span className="relative inline-flex h-14 w-14 items-center justify-center rounded-2xl border bg-card shadow-sm">
                <Loader2 className="h-6 w-6 animate-spin text-[#bf6f33] dark:text-[#e8a55a]" />
              </span>
              <div className="space-y-1">
                <p className="text-base font-medium">正在为你拉起隔离容器…</p>
                <p className="text-sm text-muted-foreground">分配资源、加固边界、附加 shell</p>
              </div>
            </div>
          </motion.div>
        )}

        {(phase === "live" || phase === "ended") && session && (
          <motion.div
            key="live"
            initial={reduced ? false : { opacity: 0 }}
            animate={{ opacity: 1 }}
            className="flex flex-1 flex-col min-h-0"
          >
            <SandboxHeader
              spec={session.sandbox}
              launchedAt={launchedAt}
              ended={phase === "ended"}
              onRelaunch={launch}
            />
            <div className="relative flex-1 min-h-0">
              {phase === "live" ? (
                <WebSSHTerminal
                  protocol="ssh"
                  nodeId={0}
                  sandbox
                  wsPath="/ws/ssh/anonymous"
                  wsToken={session.access_token}
                  displayName="匿名沙箱"
                  bannerLabel="anonymous-sandbox"
                  onStatusChange={onStatusChange}
                />
              ) : (
                <SandboxEnded reason={endReason} onRelaunch={launch} />
              )}
            </div>
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  )
}

// ----------------------------------------------------------------------------
// Landing
// ----------------------------------------------------------------------------

function SandboxIntro({
  spec,
  enabled,
  loading,
  onLaunch,
}: {
  spec?: SandboxSpec
  enabled: boolean
  loading: boolean
  onLaunch: () => void
}) {
  const reduced = useReducedMotion()
  return (
    <div className="mx-auto flex min-h-full w-full max-w-3xl flex-col justify-center gap-8 px-6 py-12">
      <motion.header
        initial={reduced ? false : { opacity: 0, y: 8 }}
        animate={{ opacity: 1, y: 0 }}
        transition={{ type: "spring", stiffness: 360, damping: 30 }}
        className="space-y-4"
      >
        <div className="flex items-center gap-3">
          <span className="inline-flex h-11 w-11 items-center justify-center rounded-xl border bg-card shadow-sm">
            <Box className="h-5 w-5 text-[#bf6f33] dark:text-[#e8a55a]" />
          </span>
          <div>
            <Badge variant="outline" className="font-normal text-[10px] uppercase tracking-wider">
              <Zap className="mr-1 h-3 w-3" /> No sign-up required
            </Badge>
          </div>
        </div>
        <div className="space-y-2">
          <h1 className="text-3xl font-semibold tracking-tight">匿名 Docker 沙箱</h1>
          <p className="max-w-xl text-[15px] leading-relaxed text-muted-foreground">
            无需注册,一键获取一个带 TTL 自动销毁的隔离 shell。容器全程断网、只读根文件系统、
            资源受限 —— 适合产品演示、CTF 靶场与临时命令练习。关闭页面或时间到期即焚。
          </p>
        </div>
      </motion.header>

      <motion.div
        initial={reduced ? false : { opacity: 0, y: 10 }}
        animate={{ opacity: 1, y: 0 }}
        transition={{ delay: 0.05, type: "spring", stiffness: 340, damping: 30 }}
        className="grid grid-cols-1 gap-3 sm:grid-cols-2"
      >
        <FeatureCard
          icon={Zap}
          title="即开即用"
          desc="无需账号,点击即获得一个干净的 Linux shell"
        />
        <FeatureCard
          icon={ShieldCheck}
          title="完全隔离"
          desc="只读根 · no-new-privileges · 默认断网,逃逸面最小化"
        />
        <FeatureCard
          icon={Timer}
          title="到期即焚"
          desc={
            spec
              ? `${formatTTL(spec.ttl_seconds)}后容器自动销毁,数据不留存`
              : "到期后容器自动销毁,数据不留存"
          }
        />
        <FeatureCard
          icon={Gauge}
          title="资源受限"
          desc={
            spec
              ? `${spec.cpu} vCPU · ${spec.memory_mb} MB 内存,公平且安全`
              : "CPU / 内存 / 进程数受限,公平且安全"
          }
        />
      </motion.div>

      {spec && (
        <motion.div
          initial={reduced ? false : { opacity: 0 }}
          animate={{ opacity: 1 }}
          transition={{ delay: 0.1 }}
          className="flex flex-wrap items-center gap-2"
        >
          <SpecChip icon={TerminalIcon} label={spec.image} />
          <SpecChip icon={Timer} label={formatTTL(spec.ttl_seconds)} />
          <SpecChip icon={MemoryStick} label={`${spec.memory_mb} MB`} />
          <SpecChip icon={Cpu} label={`${spec.cpu} vCPU`} />
          <SpecChip
            icon={Network}
            label={spec.network === "none" ? "已断网" : spec.network}
          />
        </motion.div>
      )}

      <motion.div
        initial={reduced ? false : { opacity: 0, y: 10 }}
        animate={{ opacity: 1, y: 0 }}
        transition={{ delay: 0.12, type: "spring", stiffness: 340, damping: 30 }}
        className="space-y-3"
      >
        {!enabled && !loading && (
          <div className="flex items-start gap-2 rounded-lg border border-amber-500/30 bg-amber-500/5 px-3 py-2 text-[13px] text-amber-700 dark:text-amber-400">
            <TriangleAlert className="mt-0.5 h-4 w-4 shrink-0" />
            <span>管理员当前未开启匿名沙箱功能,启动可能失败。请联系管理员在系统设置中启用。</span>
          </div>
        )}
        <Button
          size="lg"
          className="w-full sm:w-auto"
          onClick={onLaunch}
          disabled={loading}
        >
          <TerminalIcon className="h-4 w-4" />
          启动沙箱
          <ArrowRight className="h-4 w-4" />
        </Button>
        <p className="text-[12px] leading-relaxed text-muted-foreground">
          沙箱仅供临时使用,断网且到期销毁,<span className="text-foreground/80">请勿存放任何重要或敏感数据</span>。
          所有会话均会被审计记录。
        </p>
      </motion.div>

      <div className="flex items-center gap-1.5 text-[12px] text-muted-foreground">
        已有账号?
        <Link
          href="/login"
          className="inline-flex items-center gap-1 text-foreground underline-offset-4 hover:underline"
        >
          <LogIn className="h-3 w-3" /> 返回登录控制台
        </Link>
      </div>
    </div>
  )
}

function FeatureCard({
  icon: Icon,
  title,
  desc,
}: {
  icon: React.ComponentType<{ className?: string }>
  title: string
  desc: string
}) {
  return (
    <div className="flex items-start gap-3 rounded-xl border bg-card/60 p-4 transition-colors hover:bg-card">
      <span className="mt-0.5 inline-flex h-8 w-8 shrink-0 items-center justify-center rounded-lg border bg-background text-muted-foreground">
        <Icon className="h-4 w-4" />
      </span>
      <div className="space-y-0.5">
        <p className="text-sm font-medium">{title}</p>
        <p className="text-[13px] leading-relaxed text-muted-foreground">{desc}</p>
      </div>
    </div>
  )
}

function SpecChip({
  icon: Icon,
  label,
}: {
  icon: React.ComponentType<{ className?: string }>
  label: string
}) {
  return (
    <span className="inline-flex items-center gap-1.5 rounded-md border bg-muted/30 px-2.5 py-1 text-[12px] text-muted-foreground">
      <Icon className="h-3.5 w-3.5" />
      <span className="font-mono">{label}</span>
    </span>
  )
}

// ----------------------------------------------------------------------------
// Live header — brand, TTL countdown, spec chips, relaunch
// ----------------------------------------------------------------------------

function SandboxHeader({
  spec,
  launchedAt,
  ended,
  onRelaunch,
}: {
  spec: SandboxSpec
  launchedAt: number
  ended: boolean
  onRelaunch: () => void
}) {
  const remaining = useCountdown(launchedAt, spec.ttl_seconds, ended)
  const expired = remaining <= 0
  return (
    <div className="flex h-14 shrink-0 items-center justify-between gap-3 border-b bg-card/40 px-4">
      <div className="flex min-w-0 items-center gap-2.5">
        <span className="inline-flex h-8 w-8 shrink-0 items-center justify-center rounded-lg border bg-background">
          <Box className="h-4 w-4 text-[#bf6f33] dark:text-[#e8a55a]" />
        </span>
        <div className="min-w-0">
          <p className="truncate text-sm font-medium leading-tight">匿名沙箱</p>
          <p className="truncate font-mono text-[11px] text-muted-foreground">{spec.image}</p>
        </div>
      </div>

      <div className="flex items-center gap-2">
        <Badge
          variant="outline"
          className={cn(
            "gap-1 font-mono tabular-nums",
            expired
              ? "border-destructive/40 text-destructive"
              : remaining <= 60
                ? "border-amber-500/40 text-amber-600 dark:text-amber-400"
                : "text-muted-foreground",
          )}
          title="沙箱到期后将自动销毁"
        >
          <Timer className="h-3 w-3" />
          {expired ? "已到期" : formatClock(remaining)}
        </Badge>
        <Badge variant="outline" className="hidden gap-1 text-muted-foreground sm:inline-flex">
          <Network className="h-3 w-3" />
          {spec.network === "none" ? "断网" : spec.network}
        </Badge>
        <Button size="sm" variant="outline" onClick={onRelaunch} title="销毁当前沙箱并开一个新的">
          <RotateCcw className="h-3.5 w-3.5" />
          <span className="hidden sm:inline">重开</span>
        </Button>
      </div>
    </div>
  )
}

// ----------------------------------------------------------------------------
// Ended panel
// ----------------------------------------------------------------------------

function SandboxEnded({ reason, onRelaunch }: { reason: string; onRelaunch: () => void }) {
  const reduced = useReducedMotion()
  return (
    <div className="absolute inset-0 flex items-center justify-center p-6">
      <motion.div
        initial={reduced ? false : { opacity: 0, y: 8 }}
        animate={{ opacity: 1, y: 0 }}
        className="flex max-w-sm flex-col items-center gap-4 text-center"
      >
        <span className="inline-flex h-14 w-14 items-center justify-center rounded-2xl border bg-card shadow-sm">
          <Box className="h-6 w-6 text-muted-foreground" />
        </span>
        <div className="space-y-1.5">
          <p className="text-base font-medium">沙箱已销毁</p>
          <p className="text-sm leading-relaxed text-muted-foreground">
            {reason || "会话已结束"}。其中的所有数据已被回收,无法恢复。
          </p>
        </div>
        <div className="flex items-center gap-2">
          <Button onClick={onRelaunch}>
            <RotateCcw className="h-4 w-4" />
            再开一个沙箱
          </Button>
          <Button variant="outline" asChild>
            <Link href="/login">
              <LogIn className="h-4 w-4" />
              去登录
            </Link>
          </Button>
        </div>
      </motion.div>
    </div>
  )
}

// ----------------------------------------------------------------------------
// helpers
// ----------------------------------------------------------------------------

// Live seconds-remaining until the sandbox TTL fires. Frozen once ended so the
// number doesn't keep ticking under the dead-session panel.
function useCountdown(launchedAt: number, ttlSeconds: number, frozen: boolean): number {
  const compute = React.useCallback(() => {
    if (!launchedAt || !ttlSeconds) return ttlSeconds
    return Math.max(0, Math.round((launchedAt + ttlSeconds * 1000 - Date.now()) / 1000))
  }, [launchedAt, ttlSeconds])
  const [remaining, setRemaining] = React.useState(compute)
  React.useEffect(() => {
    setRemaining(compute())
    if (frozen) return
    const id = setInterval(() => setRemaining(compute()), 1000)
    return () => clearInterval(id)
  }, [compute, frozen])
  return remaining
}

function formatClock(totalSeconds: number): string {
  const s = Math.max(0, totalSeconds)
  const m = Math.floor(s / 60)
  const sec = s % 60
  return `${m}:${String(sec).padStart(2, "0")}`
}

function formatTTL(totalSeconds: number): string {
  if (!totalSeconds) return "—"
  if (totalSeconds % 3600 === 0) return `${totalSeconds / 3600} 小时`
  if (totalSeconds % 60 === 0) return `${totalSeconds / 60} 分钟`
  const m = Math.floor(totalSeconds / 60)
  const s = totalSeconds % 60
  return m > 0 ? `${m} 分 ${s} 秒` : `${s} 秒`
}
