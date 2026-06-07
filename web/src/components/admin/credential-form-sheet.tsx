"use client"

// CredentialFormSheet — the unified create / edit credential surface.
//
// Replaces the old hand-rolled AddCredentialSheet. Uses react-hook-form + zod
// for real field-level validation, supports editing (secret left blank = keep,
// so dependent grants survive), and embeds a live connectivity-test panel.
//
// Usage:
//   <CredentialFormSheet trigger={<Button>新增凭据</Button>} onSaved={...} />   // create
//   <CredentialFormSheet mode="edit" credential={c} open={...} onOpenChange={...} onSaved={...} />

import * as React from "react"
import { useForm, Controller } from "react-hook-form"
import { zodResolver } from "@hookform/resolvers/zod"
import { z } from "zod"
import { useMutation, useQuery } from "@tanstack/react-query"
import {
  CalendarClock,
  CheckCircle2,
  Eye,
  EyeOff,
  FileKey2,
  KeyRound,
  Loader2,
  Lock,
  Plus,
  Save,
  ShieldCheck,
  TestTube2,
  XCircle,
} from "lucide-react"
import { toast } from "@/components/ui/sonner"
import { cn } from "@/lib/utils"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { ScrollArea } from "@/components/ui/scroll-area"
import { Separator } from "@/components/ui/separator"
import { Switch } from "@/components/ui/switch"
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
import { Textarea } from "@/components/ui/textarea"
import { credentialService, nodeService } from "@/lib/api/services"
import type { Credential, CredentialInput } from "@/lib/api/types"

type Values = {
  name: string
  kind: "password" | "private_key" | "access_key"
  username: string
  secret: string
  passphrase: string
  description: string
  tags: string
  expires_at: string
  requires_approval_for_use: boolean
}

const PRIVATE_KEY_RE = /-----BEGIN[A-Z0-9 -]*PRIVATE KEY-----/

function makeSchema(mode: "create" | "edit") {
  // No .default()/.optional() — every field is a required (possibly empty)
  // value so the schema's input type matches `Values` exactly and zodResolver
  // types cleanly against useForm<Values>. defaultValues supplies the blanks.
  return z
    .object({
      name: z.string().trim().min(1, "请填写名称").max(128, "名称过长（≤128）"),
      kind: z.enum(["password", "private_key", "access_key"]),
      username: z.string().max(128, "用户名过长"),
      secret: z.string(),
      passphrase: z.string(),
      description: z.string().max(512, "描述过长（≤512）"),
      tags: z.string().max(256, "标签过长"),
      expires_at: z.string(),
      requires_approval_for_use: z.boolean(),
    })
    .superRefine((v, ctx) => {
      const secret = (v.secret || "").trim()
      if (mode === "create" && !secret) {
        ctx.addIssue({
          code: "custom",
          path: ["secret"],
          message:
            v.kind === "password" ? "请填写密码" : v.kind === "access_key" ? "请填写 AccessKey Secret" : "请粘贴私钥内容",
        })
      }
      if (v.kind === "private_key" && secret && !PRIVATE_KEY_RE.test(secret)) {
        ctx.addIssue({
          code: "custom",
          path: ["secret"],
          message: "私钥格式无法识别（应包含 BEGIN … PRIVATE KEY 块）",
        })
      }
    })
}

const KIND_META = {
  password: {
    icon: Lock,
    label: "用户名 + 密码",
    hint: "适用于 SSH / Telnet / RDP / VNC / 数据库 等绝大多数协议。",
  },
  private_key: {
    icon: FileKey2,
    label: "SSH 私钥",
    hint: "粘贴 OpenSSH / PEM 私钥，可选 passphrase。仅用于 SSH 系协议。",
  },
  access_key: {
    icon: KeyRound,
    label: "访问密钥 (AK/SK)",
    hint: "对象存储 AccessKey ID + Secret。用于 OSS（阿里云 / 腾讯 COS / S3）节点。",
  },
} as const

function toDateInput(iso?: string | null): string {
  if (!iso) return ""
  return iso.slice(0, 10)
}

export interface CredentialFormSheetProps {
  mode?: "create" | "edit"
  credential?: Credential
  /** Custom trigger element (uncontrolled mode). */
  trigger?: React.ReactNode
  /** Controlled open state (omit `trigger` when using these). */
  open?: boolean
  onOpenChange?: (v: boolean) => void
  /** Prefill the name when opening a fresh create form (used by the picker). */
  defaultName?: string
  onSaved?: (id: number) => void
}

export function CredentialFormSheet({
  mode = "create",
  credential,
  trigger,
  open: controlledOpen,
  onOpenChange,
  defaultName,
  onSaved,
}: CredentialFormSheetProps) {
  const isControlled = controlledOpen !== undefined
  const [internalOpen, setInternalOpen] = React.useState(false)
  const open = isControlled ? controlledOpen! : internalOpen
  const setOpen = React.useCallback(
    (v: boolean) => (isControlled ? onOpenChange?.(v) : setInternalOpen(v)),
    [isControlled, onOpenChange],
  )

  const [showSecret, setShowSecret] = React.useState(false)

  const defaults = React.useMemo<Values>(
    () => ({
      name: credential?.name ?? defaultName ?? "",
      kind: (credential?.kind === "private_key"
        ? "private_key"
        : credential?.kind === "access_key"
          ? "access_key"
          : "password") as Values["kind"],
      username: credential?.username ?? "",
      secret: "",
      passphrase: "",
      description: credential?.description ?? "",
      tags: credential?.tags ?? "",
      expires_at: toDateInput(credential?.expires_at),
      requires_approval_for_use: credential?.requires_approval_for_use ?? false,
    }),
    [credential, defaultName],
  )

  const {
    register,
    handleSubmit,
    control,
    reset,
    watch,
    formState: { errors },
  } = useForm<Values>({
    resolver: zodResolver(makeSchema(mode)),
    defaultValues: defaults,
  })

  React.useEffect(() => {
    if (open) {
      reset(defaults)
      setShowSecret(false)
    }
  }, [open, defaults, reset])

  const kind = watch("kind")
  const tags = watch("tags")

  const save = useMutation({
    mutationFn: async (v: Values): Promise<number> => {
      const body: CredentialInput = {
        name: v.name.trim(),
        kind: v.kind,
        username: v.username.trim(),
        description: v.description.trim(),
        tags: v.tags.trim(),
        expires_at: v.expires_at ? new Date(v.expires_at).toISOString() : null,
        requires_approval_for_use: v.requires_approval_for_use,
      }
      if (v.secret.trim()) body.secret = v.secret
      if (v.kind === "private_key" && v.passphrase.trim()) body.passphrase = v.passphrase
      if (mode === "edit" && credential) {
        await credentialService.update(credential.id, body)
        return credential.id
      }
      const res = await credentialService.create(body)
      return res.id
    },
    onSuccess: (id) => {
      toast.success(mode === "edit" ? "凭据已更新" : "凭据已创建")
      setOpen(false)
      onSaved?.(id)
    },
    onError: (e: Error) => toast.error(mode === "edit" ? "更新失败" : "创建失败", { description: e.message }),
  })

  const tagChips = (tags || "")
    .split(",")
    .map((t) => t.trim())
    .filter(Boolean)

  return (
    <Sheet open={open} onOpenChange={setOpen}>
      {trigger && <SheetTrigger asChild>{trigger}</SheetTrigger>}
      <SheetContent side="right" className="flex w-full flex-col gap-0 p-0 sm:max-w-lg">
        <SheetHeader className="space-y-1 border-b px-6 pb-4 pt-6">
          <SheetTitle className="flex items-center gap-2 text-base">
            <KeyRound className="h-4 w-4 text-primary" />
            {mode === "edit" ? "编辑凭据" : "新增凭据"}
          </SheetTitle>
          <SheetDescription>
            密码 / 私钥经 AEAD 信封加密后落库，<span className="font-medium text-foreground">管理员也无法回查明文</span>。
          </SheetDescription>
        </SheetHeader>

        <ScrollArea className="min-h-0 flex-1">
          <form
            id="credential-form"
            onSubmit={handleSubmit((v) => save.mutate(v))}
            className="space-y-5 px-6 py-5"
          >
            <FormField label="名称" required error={errors.name?.message}>
              <Input placeholder="如：prod-shared-root" {...register("name")} aria-invalid={!!errors.name} />
            </FormField>

            <FormField label="描述" hint="这是什么账号、归属谁、用途。便于团队协作。">
              <Input placeholder="选填，例如「生产库只读账号」" {...register("description")} />
            </FormField>

            <div className="space-y-2">
              <Label className="eyebrow">类型</Label>
              <Controller
                control={control}
                name="kind"
                render={({ field }) => (
                  <div className="grid grid-cols-3 gap-2">
                    {(["password", "private_key", "access_key"] as const).map((k) => {
                      const meta = KIND_META[k]
                      const Icon = meta.icon
                      const active = field.value === k
                      return (
                        <button
                          key={k}
                          type="button"
                          onClick={() => field.onChange(k)}
                          className={cn(
                            "flex flex-col gap-1.5 rounded-lg border bg-card p-3 text-left transition-colors outline-none focus-visible:ring-2 focus-visible:ring-ring/40",
                            active ? "border-primary ring-1 ring-primary/40" : "hover:bg-accent",
                          )}
                        >
                          <span className="flex items-center gap-1.5 text-sm font-medium">
                            <Icon className={cn("h-4 w-4", active ? "text-primary" : "text-muted-foreground")} />
                            {meta.label}
                          </span>
                          <span className="text-[11px] leading-relaxed text-muted-foreground">{meta.hint}</span>
                        </button>
                      )
                    })}
                  </div>
                )}
              />
            </div>

            <FormField
              label={kind === "access_key" ? "AccessKey ID" : "用户名"}
              hint={
                kind === "access_key"
                  ? "对象存储的 AccessKey ID（阿里云 AccessKeyId / 腾讯 SecretId / AWS AccessKeyId）。"
                  : "留空则使用各节点上配置的用户名（节点可覆盖凭据用户名）。"
              }
            >
              <Input
                placeholder={kind === "access_key" ? "AccessKey ID" : "如：root / Administrator（可留空）"}
                {...register("username")}
              />
            </FormField>

            <FormField
              label={kind === "password" ? "密码" : kind === "access_key" ? "AccessKey Secret" : "私钥（PEM / OpenSSH）"}
              required={mode === "create"}
              error={errors.secret?.message}
              hint={mode === "edit" ? "留空表示保留当前密钥，不做修改。" : undefined}
            >
              {kind !== "private_key" ? (
                <div className="relative">
                  <Input
                    type={showSecret ? "text" : "password"}
                    autoComplete="new-password"
                    placeholder={mode === "edit" ? "••••••••（留空不修改）" : kind === "access_key" ? "AccessKey Secret" : "输入密码"}
                    className="pr-9"
                    aria-invalid={!!errors.secret}
                    {...register("secret")}
                  />
                  <Button
                    type="button"
                    size="icon"
                    variant="ghost"
                    className="absolute right-0.5 top-0.5 h-8 w-8 text-muted-foreground"
                    onClick={() => setShowSecret((v) => !v)}
                    aria-label={showSecret ? "隐藏" : "显示"}
                  >
                    {showSecret ? <EyeOff className="h-3.5 w-3.5" /> : <Eye className="h-3.5 w-3.5" />}
                  </Button>
                </div>
              ) : (
                <Textarea
                  rows={8}
                  spellCheck={false}
                  placeholder={
                    mode === "edit"
                      ? "留空保留当前私钥；或粘贴新私钥进行轮换"
                      : "-----BEGIN OPENSSH PRIVATE KEY-----\n...\n-----END OPENSSH PRIVATE KEY-----"
                  }
                  className="font-mono text-xs leading-relaxed"
                  aria-invalid={!!errors.secret}
                  {...register("secret")}
                />
              )}
            </FormField>

            {kind === "private_key" && (
              <FormField
                label="私钥密码 (passphrase)"
                hint={mode === "edit" ? "留空保留；输入新值轮换。" : "仅当私钥本身被加密时填写。"}
              >
                <Input type="password" autoComplete="off" placeholder="可选" {...register("passphrase")} />
              </FormField>
            )}

            <Separator />

            <FormField label="标签" hint="逗号分隔，便于筛选。如：prod,linux,shared">
              <Input placeholder="prod,linux,shared" {...register("tags")} />
              {tagChips.length > 0 && (
                <div className="flex flex-wrap gap-1.5 pt-1.5">
                  {tagChips.map((t) => (
                    <Badge key={t} variant="soft" className="rounded-full font-normal">
                      {t}
                    </Badge>
                  ))}
                </div>
              )}
            </FormField>

            <FormField label="过期提醒" hint="到期后列表会高亮提示，但不会自动断开连接。">
              <div className="relative">
                <CalendarClock className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
                <Input type="date" className="pl-9" {...register("expires_at")} />
              </div>
            </FormField>

            <Controller
              control={control}
              name="requires_approval_for_use"
              render={({ field }) => (
                <label className="flex items-start justify-between gap-3 rounded-lg border bg-card p-3">
                  <div className="space-y-0.5">
                    <span className="flex items-center gap-1.5 text-sm font-medium">
                      <ShieldCheck className="h-4 w-4 text-muted-foreground" /> 使用前需审批
                    </span>
                    <p className="text-[11px] leading-relaxed text-muted-foreground">
                      开启后，解密该凭据需要一条有效的 credential_use 审批授权。适合 root / dba 等高危账号。
                    </p>
                  </div>
                  <Switch checked={field.value} onCheckedChange={field.onChange} />
                </label>
              )}
            />

            {mode === "edit" && credential && <TestPanel credentialId={credential.id} />}
          </form>
        </ScrollArea>

        <SheetFooter className="flex-row items-center justify-end gap-2 border-t bg-secondary/40 px-6 py-3">
          <Button variant="outline" onClick={() => setOpen(false)} disabled={save.isPending}>
            取消
          </Button>
          <Button type="submit" form="credential-form" disabled={save.isPending}>
            {save.isPending ? (
              <Loader2 className="h-4 w-4 animate-spin" />
            ) : mode === "edit" ? (
              <Save className="h-4 w-4" />
            ) : (
              <Plus className="h-4 w-4" />
            )}
            {mode === "edit" ? "保存修改" : "创建凭据"}
          </Button>
        </SheetFooter>
      </SheetContent>
    </Sheet>
  )
}

// --- inline connectivity test (edit mode only — needs a persisted credential) ---

function TestPanel({ credentialId }: { credentialId: number }) {
  const nodes = useQuery({ queryKey: ["credential-test-nodes"], queryFn: nodeService.list })
  const [nodeId, setNodeId] = React.useState<string>("")
  const [host, setHost] = React.useState("")
  const [port, setPort] = React.useState("22")

  const test = useMutation({
    mutationFn: () => {
      if (nodeId) return credentialService.test(credentialId, { node_id: Number(nodeId) })
      return credentialService.test(credentialId, { host: host.trim(), port: Number(port) || 22 })
    },
  })

  const sshNodes = (nodes.data?.nodes || []).filter((n) => n.protocol === "ssh" || n.protocol === "telnet")
  const canTest = !test.isPending && (!!nodeId || host.trim().length > 0)
  const result = test.data

  return (
    <div className="space-y-3 rounded-lg border border-dashed bg-secondary/30 p-3">
      <div className="flex items-center gap-1.5 text-sm font-medium">
        <TestTube2 className="h-4 w-4 text-muted-foreground" /> 连通性测试
        <span className="text-[11px] font-normal text-muted-foreground">通过 SSH 直连验证凭据是否可用</span>
      </div>

      <div className="grid grid-cols-1 gap-2">
        <Select
          value={nodeId}
          onValueChange={(v) => {
            setNodeId(v)
            setHost("")
          }}
        >
          <SelectTrigger>
            <SelectValue placeholder="选择一个节点进行测试" />
          </SelectTrigger>
          <SelectContent>
            {sshNodes.map((n) => (
              <SelectItem key={n.id} value={String(n.id)}>
                {n.name} · {n.host}:{n.port}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>

        <div className="flex items-center gap-1.5 text-[11px] text-muted-foreground">
          <span className="h-px flex-1 bg-border" /> 或手动指定主机 <span className="h-px flex-1 bg-border" />
        </div>

        <div className="flex gap-2">
          <Input
            placeholder="host / IP"
            value={host}
            onChange={(e) => {
              setHost(e.target.value)
              if (e.target.value) setNodeId("")
            }}
          />
          <Input
            className="w-24"
            type="number"
            placeholder="端口"
            value={port}
            onChange={(e) => setPort(e.target.value)}
          />
        </div>
      </div>

      <div className="flex items-center justify-between gap-2">
        <Button type="button" variant="outline" size="sm" disabled={!canTest} onClick={() => test.mutate()}>
          {test.isPending ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <TestTube2 className="h-3.5 w-3.5" />}
          测试
        </Button>
        {test.isError && (
          <span className="flex items-center gap-1 text-xs text-destructive">
            <XCircle className="h-3.5 w-3.5" /> 请求失败
          </span>
        )}
        {result &&
          (result.ok ? (
            <span className="flex items-center gap-1 text-xs text-emerald-600 dark:text-emerald-400">
              <CheckCircle2 className="h-3.5 w-3.5" /> 连接成功 {result.latency_ms != null && `· ${result.latency_ms}ms`}
            </span>
          ) : (
            <span className="flex max-w-[60%] items-center gap-1 truncate text-xs text-destructive" title={result.error}>
              <XCircle className="h-3.5 w-3.5 shrink-0" /> {result.error || "连接失败"}
            </span>
          ))}
      </div>
    </div>
  )
}

// --- shared field wrapper ---

function FormField({
  label,
  required,
  hint,
  error,
  children,
}: {
  label: string
  required?: boolean
  hint?: string
  error?: string
  children: React.ReactNode
}) {
  return (
    <div className="space-y-1.5">
      <Label className="eyebrow">
        {label}
        {required && <span className="ml-0.5 normal-case text-destructive">*</span>}
      </Label>
      {children}
      {error ? (
        <p className="text-[11px] text-destructive">{error}</p>
      ) : hint ? (
        <p className="text-[11px] leading-relaxed text-muted-foreground">{hint}</p>
      ) : null}
    </div>
  )
}
