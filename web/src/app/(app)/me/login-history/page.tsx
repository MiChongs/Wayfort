"use client"
import { useQuery } from "@tanstack/react-query"
import { meService } from "@/lib/api/services"
import { Badge } from "@/components/ui/badge"
import { fullTime, relTime } from "@/lib/format"

export default function LoginHistoryPage() {
  const q = useQuery({ queryKey: ["me", "login-history"], queryFn: () => meService.loginHistory(100) })
  return (
    <div className="p-6 space-y-4">
      <h1 className="text-2xl font-semibold tracking-tight">登录历史</h1>
      <div className="rounded-lg border overflow-hidden">
        <table className="w-full text-sm">
          <thead className="bg-muted text-xs uppercase text-muted-foreground">
            <tr>
              <th className="text-left px-3 py-2">时间</th>
              <th className="text-left px-3 py-2">IP</th>
              <th className="text-left px-3 py-2">客户端</th>
              <th className="text-left px-3 py-2">结果</th>
              <th className="text-left px-3 py-2">认证方式</th>
              <th className="text-left px-3 py-2">异常</th>
            </tr>
          </thead>
          <tbody>
            {(q.data?.history || []).map((h) => (
              <tr key={h.id} className="border-t">
                <td className="px-3 py-2 text-xs">
                  <div>{fullTime(h.created_at)}</div>
                  <div className="text-muted-foreground">{relTime(h.created_at)}</div>
                </td>
                <td className="px-3 py-2 font-mono text-xs">{h.ip}</td>
                <td className="px-3 py-2 text-xs text-muted-foreground truncate max-w-xs">{h.user_agent}</td>
                <td className="px-3 py-2">
                  <Badge variant={h.result === "success" ? "success" : "destructive"}>{h.result}</Badge>
                </td>
                <td className="px-3 py-2 text-xs">{h.auth_method}{h.mfa_method !== "none" ? ` + ${h.mfa_method}` : ""}</td>
                <td className="px-3 py-2">{h.anomaly && <Badge variant="warning">anomaly</Badge>}</td>
              </tr>
            ))}
            {q.isLoading && <tr><td colSpan={6} className="text-center text-muted-foreground py-6">加载中…</td></tr>}
          </tbody>
        </table>
      </div>
    </div>
  )
}
