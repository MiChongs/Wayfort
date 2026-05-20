"use client"

// Phase 10 — credentials page using AddCredentialSheet + AlertDialog delete.

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query"
import { KeyRound } from "lucide-react"
import { toast } from "sonner"
import { Badge } from "@/components/ui/badge"
import { DataTable, type Column } from "@/components/common/data-table"
import { AddCredentialSheet } from "@/components/admin/add-credential-sheet"
import { ConfirmDeleteIconButton } from "@/components/admin/confirm-delete"
import { credentialService } from "@/lib/api/services"
import type { Credential } from "@/lib/api/types"

export default function CredentialsPage() {
  const qc = useQueryClient()
  const q = useQuery({ queryKey: ["admin", "credentials"], queryFn: credentialService.list })
  const remove = useMutation({
    mutationFn: (id: number) => credentialService.remove(id),
    onSuccess: () => {
      toast.success("凭据已删除")
      qc.invalidateQueries({ queryKey: ["admin", "credentials"] })
    },
    onError: (e: Error) => toast.error("删除失败", { description: e.message }),
  })

  const columns: Column<Credential>[] = [
    { header: "名称", cell: (c) => <span className="font-medium">{c.name}</span> },
    { header: "类型", cell: (c) => <Badge variant="secondary">{c.kind}</Badge> },
    { header: "用户名", cell: (c) => c.username || "—" },
    {
      header: "操作",
      className: "text-right",
      cell: (c) => (
        <ConfirmDeleteIconButton
          title={`删除凭据 “${c.name}”？`}
          description="使用此凭据的节点登录、代理 bastion 会立刻失效。"
          loading={remove.isPending}
          onConfirm={() => remove.mutate(c.id)}
        />
      ),
    },
  ]

  return (
    <div className="space-y-4 p-6">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="flex items-center gap-2 text-2xl font-semibold tracking-tight">
            <KeyRound className="h-5 w-5" /> 凭据
          </h1>
          <p className="text-sm text-muted-foreground">集中管理密码与 SSH 私钥,加密存储。</p>
        </div>
        <AddCredentialSheet onCreated={() => qc.invalidateQueries({ queryKey: ["admin", "credentials"] })} />
      </div>
      <DataTable columns={columns} rows={q.data?.credentials} loading={q.isLoading} />
    </div>
  )
}
