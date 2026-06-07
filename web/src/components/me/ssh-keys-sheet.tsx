"use client"

// Phase 12 — SSH Keys management Sheet.
//
// 用户自助维护 SSH keypair:
//   - 生成新密钥(ED25519 / RSA 2048/3072/4096),仅首次创建时返回私钥 PEM
//     (`private_pem_one_time`),下载后服务端不再回查
//   - 导入已有 PEM 私钥(可选 passphrase)
//   - 列表:fingerprint + type + 创建时间 + 最近使用时间
//   - 重命名 + 删除(走 shadcn AlertDialog)
//
// Sheet 内嵌一个标签页(列表 ↔ 新建),所有大表单走 Sheet 而非 Dialog。

import * as React from "react"
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query"
import { motion } from "motion/react"
import {
  Clipboard,
  Download,
  Eye,
  EyeOff,
  Key,
  Loader2,
  Plus,
  Sparkles,
  Upload,
} from "lucide-react"
import { toast } from "@/components/ui/sonner"
import { cn } from "@/lib/utils"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Card, CardContent } from "@/components/ui/card"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { ScrollArea } from "@/components/ui/scroll-area"
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select"
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetFooter,
  SheetHeader,
  SheetTitle,
  SheetTrigger,
} from "@/components/ui/sheet"
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs"
import { Textarea } from "@/components/ui/textarea"
import { ConfirmDeleteIconButton } from "@/components/admin/confirm-delete"
import { sshKeyService } from "@/lib/api/services"
import type { SSHKey } from "@/lib/api/types"

const KEY_TYPES = [
  { value: "ed25519", label: "ED25519 (推荐)" },
  { value: "rsa-2048", label: "RSA 2048" },
  { value: "rsa-3072", label: "RSA 3072" },
  { value: "rsa-4096", label: "RSA 4096" },
]

export function SSHKeysSheet({
  trigger,
}: {
  trigger?: React.ReactNode
}) {
  const [open, setOpen] = React.useState(false)
  const [tab, setTab] = React.useState<"list" | "create">("list")
  const qc = useQueryClient()
  const list = useQuery({
    queryKey: ["me", "ssh-keys"],
    queryFn: sshKeyService.list,
    enabled: open,
  })

  React.useEffect(() => {
    if (!open) setTab("list")
  }, [open])

  return (
    <Sheet open={open} onOpenChange={setOpen}>
      <SheetTrigger asChild>
        {trigger || (
          <Button variant="outline" size="sm">
            <Key className="h-3.5 w-3.5" /> 我的 SSH 密钥
          </Button>
        )}
      </SheetTrigger>
      <SheetContent side="right" className="flex w-full flex-col gap-0 p-0 sm:max-w-[560px]">
        <SheetHeader className="border-b px-6 pt-6 pb-4">
          <SheetTitle className="flex items-center gap-2 text-base">
            <Key className="h-4 w-4" /> 我的 SSH 密钥
          </SheetTitle>
          <SheetDescription>
            用户级 ED25519 / RSA 密钥库,生成的私钥仅在 “创建” 时返回一次,下载后请妥善保管。
          </SheetDescription>
        </SheetHeader>
        <Tabs value={tab} onValueChange={(v) => setTab(v as "list" | "create")} className="flex min-h-0 flex-1 flex-col">
          <TabsList className="mx-6 mt-4 self-start">
            <TabsTrigger value="list">
              <Key className="h-3.5 w-3.5" /> 列表 ({list.data?.keys.length ?? 0})
            </TabsTrigger>
            <TabsTrigger value="create">
              <Plus className="h-3.5 w-3.5" /> 新建 / 导入
            </TabsTrigger>
          </TabsList>
          <TabsContent value="list" className="mt-0 flex min-h-0 flex-1 flex-col">
            <ScrollArea className="min-h-0 flex-1 px-6 py-4">
              {list.isLoading ? (
                <div className="flex items-center gap-2 px-3 py-4 text-xs text-muted-foreground">
                  <Loader2 className="h-3.5 w-3.5 animate-spin" /> 加载中...
                </div>
              ) : (list.data?.keys.length ?? 0) === 0 ? (
                <div className="flex flex-col items-center gap-2 px-3 py-10 text-center text-xs text-muted-foreground">
                  <Sparkles className="h-6 w-6 opacity-60" />
                  <p>还没有密钥。切换 “新建 / 导入” 创建第一个。</p>
                </div>
              ) : (
                <div className="space-y-2">
                  {list.data!.keys.map((k) => (
                    <KeyRow
                      key={k.id}
                      k={k}
                      onChanged={() => qc.invalidateQueries({ queryKey: ["me", "ssh-keys"] })}
                    />
                  ))}
                </div>
              )}
            </ScrollArea>
          </TabsContent>
          <TabsContent value="create" className="mt-0 flex min-h-0 flex-1 flex-col">
            <CreateKeyForm
              onCreated={() => {
                qc.invalidateQueries({ queryKey: ["me", "ssh-keys"] })
                setTab("list")
              }}
            />
          </TabsContent>
        </Tabs>
      </SheetContent>
    </Sheet>
  )
}

function KeyRow({ k, onChanged }: { k: SSHKey; onChanged: () => void }) {
  const [showFull, setShowFull] = React.useState(false)
  const remove = useMutation({
    mutationFn: () => sshKeyService.remove(k.id),
    onSuccess: () => {
      toast.success("已删除")
      onChanged()
    },
  })
  const copy = (text: string, label: string) => {
    navigator.clipboard.writeText(text).then(() => toast.success(`${label} 已复制`))
  }
  return (
    <Card className="group">
      <CardContent className="space-y-2 p-3">
        <div className="flex items-center justify-between gap-2">
          <div className="flex min-w-0 items-center gap-1.5">
            <span className="truncate text-sm font-medium">{k.name}</span>
            <Badge variant="secondary" className="font-normal">{k.type}</Badge>
          </div>
          <div className="flex items-center gap-0.5">
            <Button
              size="icon"
              variant="ghost"
              className="h-6 w-6"
              onClick={() => copy(k.public, "Public Key")}
              title="复制 public key"
            >
              <Clipboard className="h-3 w-3" />
            </Button>
            <ConfirmDeleteIconButton
              className="h-6 w-6"
              iconClassName="h-3 w-3"
              title={`删除密钥 "${k.name}"?`}
              description="该操作不可恢复。已经使用此公钥的远端节点 authorized_keys 不会自动清理。"
              loading={remove.isPending}
              onConfirm={() => remove.mutate()}
            />
          </div>
        </div>
        <pre className="overflow-x-auto rounded-md border bg-muted/40 px-2 py-1.5 font-mono text-[10px] leading-snug">
          {showFull ? k.public : k.public.length > 80 ? k.public.slice(0, 80) + "…" : k.public}
        </pre>
        <div className="flex items-center justify-between gap-2">
          <div className="flex items-center gap-1.5 text-[10px] text-muted-foreground">
            <span className="font-mono">{k.fingerprint}</span>
            {k.last_used_at && <span>· 最近使用 {new Date(k.last_used_at).toLocaleDateString()}</span>}
          </div>
          <Button
            size="sm"
            variant="ghost"
            className="h-5 px-1.5 text-[10px]"
            onClick={() => setShowFull((v) => !v)}
          >
            {showFull ? <EyeOff className="h-3 w-3" /> : <Eye className="h-3 w-3" />}
            {showFull ? "折叠" : "展开"}
          </Button>
        </div>
      </CardContent>
    </Card>
  )
}

function CreateKeyForm({ onCreated }: { onCreated: () => void }) {
  const [mode, setMode] = React.useState<"generate" | "import">("generate")
  const [name, setName] = React.useState("")
  const [type, setType] = React.useState("ed25519")
  const [imported, setImported] = React.useState("")
  const [passphrase, setPassphrase] = React.useState("")
  const [downloadable, setDownloadable] = React.useState<{ name: string; pem: string } | null>(null)

  const create = useMutation({
    mutationFn: () =>
      sshKeyService.create({
        name,
        type,
        private: mode === "import" ? imported : undefined,
        passphrase: passphrase || undefined,
      }),
    onSuccess: (r) => {
      toast.success("密钥已创建")
      if (mode === "generate" && r.private_pem_one_time) {
        setDownloadable({ name: name + ".pem", pem: r.private_pem_one_time })
      } else {
        onCreated()
      }
    },
    onError: (e: Error) => toast.error("创建失败", { description: e.message }),
  })

  const canSave = !!name.trim() && (mode === "generate" || !!imported.trim()) && !create.isPending

  if (downloadable) {
    return (
      <div className="flex min-h-0 flex-1 flex-col">
        <ScrollArea className="min-h-0 flex-1 px-6 py-4">
          <Card className="border-amber-500/30 bg-amber-500/5">
            <CardContent className="space-y-3 p-4">
              <div className="flex items-center gap-2 text-amber-700 dark:text-amber-300">
                <Sparkles className="h-4 w-4" />
                <span className="text-sm font-semibold">私钥仅显示一次,请立即保存</span>
              </div>
              <Textarea
                value={downloadable.pem}
                readOnly
                rows={12}
                className="font-mono text-[10px] leading-snug"
              />
              <div className="flex items-center gap-2">
                <Button
                  size="sm"
                  variant="outline"
                  onClick={() =>
                    navigator.clipboard.writeText(downloadable.pem).then(() => toast.success("已复制"))
                  }
                >
                  <Clipboard className="h-3.5 w-3.5" /> 复制
                </Button>
                <Button
                  size="sm"
                  variant="outline"
                  onClick={() => {
                    const blob = new Blob([downloadable.pem], { type: "application/x-pem-file" })
                    const url = URL.createObjectURL(blob)
                    const a = document.createElement("a")
                    a.href = url
                    a.download = downloadable.name
                    a.click()
                    URL.revokeObjectURL(url)
                  }}
                >
                  <Download className="h-3.5 w-3.5" /> 下载 PEM
                </Button>
              </div>
            </CardContent>
          </Card>
        </ScrollArea>
        <SheetFooter className="flex-row items-center justify-end gap-2 border-t bg-muted/30 px-6 py-3">
          <Button onClick={onCreated}>我已保存,返回列表</Button>
        </SheetFooter>
      </div>
    )
  }

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <ScrollArea className="min-h-0 flex-1 px-6 py-4">
        <div className="space-y-4">
          <div className="grid grid-cols-2 gap-2">
            <button
              type="button"
              className={cn(
                "rounded-md border bg-card p-3 text-left transition-colors hover:bg-muted/60",
                mode === "generate" && "border-primary ring-1 ring-primary",
              )}
              onClick={() => setMode("generate")}
            >
              <div className="flex items-center gap-2 text-sm font-medium">
                <Sparkles className="h-3.5 w-3.5" /> 生成新密钥
              </div>
              <p className="mt-1 text-[11px] text-muted-foreground">服务端用 crypto/rand 生成,私钥仅返回一次。</p>
            </button>
            <button
              type="button"
              className={cn(
                "rounded-md border bg-card p-3 text-left transition-colors hover:bg-muted/60",
                mode === "import" && "border-primary ring-1 ring-primary",
              )}
              onClick={() => setMode("import")}
            >
              <div className="flex items-center gap-2 text-sm font-medium">
                <Upload className="h-3.5 w-3.5" /> 导入 PEM
              </div>
              <p className="mt-1 text-[11px] text-muted-foreground">粘贴现有私钥;支持 OpenSSH / PKCS8 + passphrase。</p>
            </button>
          </div>

          <Field label="名称" required>
            <Input value={name} onChange={(e) => setName(e.target.value)} placeholder="如:laptop@2026" />
          </Field>

          {mode === "generate" ? (
            <Field label="类型">
              <Select value={type} onValueChange={setType}>
                <SelectTrigger><SelectValue /></SelectTrigger>
                <SelectContent>
                  {KEY_TYPES.map((t) => (
                    <SelectItem key={t.value} value={t.value}>{t.label}</SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </Field>
          ) : (
            <>
              <Field label="PEM 私钥" required>
                <Textarea
                  rows={10}
                  value={imported}
                  onChange={(e) => setImported(e.target.value)}
                  placeholder={"-----BEGIN OPENSSH PRIVATE KEY-----\n...\n-----END OPENSSH PRIVATE KEY-----"}
                  className="font-mono text-xs leading-relaxed"
                />
              </Field>
              <Field label="Passphrase (可选)">
                <Input
                  type="password"
                  value={passphrase}
                  onChange={(e) => setPassphrase(e.target.value)}
                />
              </Field>
            </>
          )}
        </div>
      </ScrollArea>
      <SheetFooter className="flex-row items-center justify-end gap-2 border-t bg-muted/30 px-6 py-3">
        <Button onClick={() => create.mutate()} disabled={!canSave}>
          {create.isPending ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Plus className="h-3.5 w-3.5" />}
          {mode === "generate" ? "生成并保存" : "导入并保存"}
        </Button>
      </SheetFooter>
    </div>
  )
}

function Field({
  label,
  required,
  children,
}: {
  label: string
  required?: boolean
  children: React.ReactNode
}) {
  return (
    <div className="space-y-1.5">
      <Label className="text-xs uppercase tracking-wide text-muted-foreground">
        {label}
        {required && <span className="ml-0.5 text-destructive">*</span>}
      </Label>
      {children}
    </div>
  )
}
