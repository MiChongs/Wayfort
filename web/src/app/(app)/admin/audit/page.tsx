"use client"
import { ScrollText } from "lucide-react"

export default function AuditPage() {
  return (
    <div className="p-6 space-y-3">
      <h1 className="text-2xl font-semibold tracking-tight flex items-center gap-2">
        <ScrollText className="w-5 h-5" /> 审计日志
      </h1>
      <p className="text-sm text-muted-foreground">
        会话级审计请到「会话历史」查看；登录与权限事件保留在 audit_logs 表里，
        可通过 AI 助手的 <code>audit_query</code> 工具按 session_id / kind 检索。
      </p>
    </div>
  )
}
