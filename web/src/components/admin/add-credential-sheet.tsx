"use client"

// AddCredentialSheet — replaces credentials/page.tsx CreateDialog. Uses a
// shadcn Sheet so the long secret-paste area has room to breathe (a Dialog
// fights the height of a private key).

import * as React from "react"
import { useMutation } from "@tanstack/react-query"
import { Eye, EyeOff, KeyRound, Loader2, Plus, Shield } from "lucide-react"
import { toast } from "sonner"
import { cn } from "@/lib/utils"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { ScrollArea } from "@/components/ui/scroll-area"
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetFooter,
  SheetHeader,
  SheetTitle,
  SheetTrigger,
} from "@/components/ui/sheet"
import { Textarea } from "@/components/ui/textarea"
import { credentialService } from "@/lib/api/services"

const KINDS = [
  {
    id: "password",
    label: "用户名 + 密码",
    description: "支持 SSH / Telnet / RDP / VNC / 数据库等大多数协议。",
  },
  {
    id: "private_key",
    label: "SSH 私钥",
    description: "粘贴 OpenSSH 私钥(PEM/OPENSSH 格式)。可选 passphrase。",
  },
] as const

export interface AddCredentialSheetProps {
  onCreated: () => void
}

export function AddCredentialSheet({ onCreated }: AddCredentialSheetProps) {
  const [open, setOpen] = React.useState(false)
  const [c, setC] = React.useState(initial())
  const [showSecret, setShowSecret] = React.useState(false)

  React.useEffect(() => {
    if (open) {
      setC(initial())
      setShowSecret(false)
    }
  }, [open])

  const create = useMutation({
    mutationFn: () => credentialService.create(c),
    onSuccess: () => {
      toast.success("凭据已创建")
      setOpen(false)
      onCreated()
    },
    onError: (e: Error) => toast.error("创建失败", { description: e.message }),
  })

  const canCreate = !!c.name.trim() && !!c.secret.trim() && !create.isPending

  return (
    <Sheet open={open} onOpenChange={setOpen}>
      <SheetTrigger asChild>
        <Button>
          <Plus className="h-4 w-4" /> 新增凭据
        </Button>
      </SheetTrigger>
      <SheetContent side="right" className="flex w-full flex-col gap-0 p-0 sm:max-w-md">
        <SheetHeader className="border-b px-6 pt-6 pb-4">
          <SheetTitle className="flex items-center gap-2 text-base">
            <KeyRound className="h-4 w-4" /> 新增凭据
          </SheetTitle>
          <SheetDescription>
            密码 / 私钥使用 master key 加密后存储,不会在 list 接口里返回明文。
          </SheetDescription>
        </SheetHeader>

        <ScrollArea className="min-h-0 flex-1 px-6 py-4">
          <div className="space-y-4">
            <Field label="名称" required>
              <Input
                value={c.name}
                onChange={(e) => setC({ ...c, name: e.target.value })}
                placeholder="如:prod-shared-key"
              />
            </Field>

            <div className="space-y-1.5">
              <Label className="text-xs font-medium uppercase tracking-wide text-muted-foreground">类型</Label>
              <div className="grid grid-cols-2 gap-2">
                {KINDS.map((k) => (
                  <button
                    key={k.id}
                    type="button"
                    onClick={() => setC({ ...c, kind: k.id })}
                    className={cn(
                      "rounded-md border bg-card p-3 text-left transition-colors hover:bg-muted/60 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
                      c.kind === k.id && "border-primary ring-1 ring-primary",
                    )}
                  >
                    <span className="text-sm font-medium">{k.label}</span>
                    <p className="mt-1 text-[11px] leading-relaxed text-muted-foreground">{k.description}</p>
                  </button>
                ))}
              </div>
            </div>

            <Field label="用户名">
              <Input
                value={c.username}
                onChange={(e) => setC({ ...c, username: e.target.value })}
                placeholder="可留空,使用节点上的用户名"
              />
            </Field>

            <Field
              label={c.kind === "password" ? "密码" : "私钥(PEM / OpenSSH)"}
              required
            >
              <div className="space-y-1.5">
                {c.kind === "password" ? (
                  <div className="relative">
                    <Input
                      type={showSecret ? "text" : "password"}
                      value={c.secret}
                      onChange={(e) => setC({ ...c, secret: e.target.value })}
                      className="pr-9"
                    />
                    <Button
                      type="button"
                      size="icon"
                      variant="ghost"
                      className="absolute right-0.5 top-0.5 h-8 w-8 text-muted-foreground"
                      onClick={() => setShowSecret((v) => !v)}
                    >
                      {showSecret ? <EyeOff className="h-3.5 w-3.5" /> : <Eye className="h-3.5 w-3.5" />}
                    </Button>
                  </div>
                ) : (
                  <Textarea
                    rows={8}
                    spellCheck={false}
                    value={c.secret}
                    onChange={(e) => setC({ ...c, secret: e.target.value })}
                    placeholder={`-----BEGIN OPENSSH PRIVATE KEY-----\n...\n-----END OPENSSH PRIVATE KEY-----`}
                    className="font-mono text-xs leading-relaxed"
                  />
                )}
                <p className="flex items-center gap-1 text-[11px] text-muted-foreground">
                  <Shield className="h-3 w-3" /> 加密存储,管理员也无法回查明文
                </p>
              </div>
            </Field>

            {c.kind === "private_key" && (
              <Field label="私钥密码 (可选)">
                <Input
                  type="password"
                  value={c.passphrase}
                  onChange={(e) => setC({ ...c, passphrase: e.target.value })}
                />
              </Field>
            )}

            <div className="rounded-md border bg-muted/30 p-3 text-[11px] text-muted-foreground">
              凭据用途:
              <ul className="mt-1 space-y-0.5">
                <li>· 节点登录(SSH / RDP / 数据库)</li>
                <li>· SSH 跳板代理(bastion)身份</li>
                <li>· SOCKS5 代理可选鉴权</li>
              </ul>
              <div className="mt-2 flex gap-1.5">
                <Badge variant="outline" className="font-normal">AEAD 加密</Badge>
                <Badge variant="outline" className="font-normal">仅返回 4 位后缀</Badge>
              </div>
            </div>
          </div>
        </ScrollArea>

        <SheetFooter className="flex-row items-center justify-end gap-2 border-t bg-muted/30 px-6 py-3">
          <Button variant="outline" onClick={() => setOpen(false)} disabled={create.isPending}>
            取消
          </Button>
          <Button onClick={() => create.mutate()} disabled={!canCreate}>
            {create.isPending ? <Loader2 className="h-4 w-4 animate-spin" /> : <Plus className="h-4 w-4" />}
            创建
          </Button>
        </SheetFooter>
      </SheetContent>
    </Sheet>
  )
}

function Field({
  label,
  required,
  className,
  children,
}: {
  label: string
  required?: boolean
  className?: string
  children: React.ReactNode
}) {
  return (
    <div className={cn("space-y-1.5", className)}>
      <Label className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
        {label}
        {required && <span className="ml-0.5 text-destructive">*</span>}
      </Label>
      {children}
    </div>
  )
}

function initial() {
  return { name: "", kind: "password" as "password" | "private_key", username: "", secret: "", passphrase: "" }
}
