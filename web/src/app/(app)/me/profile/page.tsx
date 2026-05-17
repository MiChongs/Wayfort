"use client"

import * as React from "react"
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query"
import { toast } from "sonner"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card"
import { meService } from "@/lib/api/services"

export default function ProfilePage() {
  const qc = useQueryClient()
  const me = useQuery({ queryKey: ["me", "profile"], queryFn: meService.profile })
  const [draft, setDraft] = React.useState<{ display_name?: string; email?: string; phone?: string }>({})

  React.useEffect(() => {
    if (me.data) setDraft({ display_name: me.data.display_name, email: me.data.email, phone: me.data.phone })
  }, [me.data])

  const update = useMutation({
    mutationFn: () => meService.updateProfile(draft),
    onSuccess: () => { qc.invalidateQueries({ queryKey: ["me", "profile"] }); toast.success("已更新") },
    onError: (e: unknown) => toast.error("更新失败", { description: (e as Error).message }),
  })

  const [oldPw, setOldPw] = React.useState("")
  const [newPw, setNewPw] = React.useState("")
  const changePw = useMutation({
    mutationFn: () => meService.changePassword(oldPw, newPw),
    onSuccess: () => { setOldPw(""); setNewPw(""); toast.success("密码已修改") },
    onError: (e: unknown) => toast.error("修改失败", { description: (e as Error).message }),
  })

  return (
    <div className="p-6 max-w-2xl space-y-6">
      <h1 className="text-2xl font-semibold tracking-tight">个人资料</h1>
      <Card>
        <CardHeader><CardTitle>基本信息</CardTitle></CardHeader>
        <CardContent className="pb-6 space-y-3">
          <Field label="用户名" value={me.data?.username || ""} readonly />
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
            <div className="space-y-1.5">
              <Label>显示名</Label>
              <Input value={draft.display_name || ""} onChange={(e) => setDraft((d) => ({ ...d, display_name: e.target.value }))} />
            </div>
            <div className="space-y-1.5">
              <Label>邮箱</Label>
              <Input value={draft.email || ""} onChange={(e) => setDraft((d) => ({ ...d, email: e.target.value }))} />
            </div>
            <div className="space-y-1.5">
              <Label>电话</Label>
              <Input value={draft.phone || ""} onChange={(e) => setDraft((d) => ({ ...d, phone: e.target.value }))} />
            </div>
          </div>
          <Button onClick={() => update.mutate()} disabled={update.isPending}>保存</Button>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>修改密码</CardTitle>
          <CardDescription>修改后需要重新登录</CardDescription>
        </CardHeader>
        <CardContent className="pb-6 space-y-3">
          <div className="space-y-1.5">
            <Label>当前密码</Label>
            <Input type="password" value={oldPw} onChange={(e) => setOldPw(e.target.value)} />
          </div>
          <div className="space-y-1.5">
            <Label>新密码（至少 8 位）</Label>
            <Input type="password" value={newPw} onChange={(e) => setNewPw(e.target.value)} />
          </div>
          <Button onClick={() => changePw.mutate()} disabled={!oldPw || newPw.length < 8 || changePw.isPending}>
            修改密码
          </Button>
        </CardContent>
      </Card>
    </div>
  )
}

function Field({ label, value, readonly }: { label: string; value: string; readonly?: boolean }) {
  return (
    <div className="space-y-1.5">
      <Label>{label}</Label>
      <Input value={value} readOnly={readonly} disabled={readonly} />
    </div>
  )
}
