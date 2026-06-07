"use client"

import { SandboxConsole } from "@/components/sandbox/sandbox-console"

// 匿名 Docker 沙箱 — 无需注册的一次性隔离 shell。整页由 SandboxConsole 驱动
// (落地 → 启动 → 终端 → 到期),复用与节点会话同一套终端体验。
export default function SandboxPage() {
  return <SandboxConsole />
}
