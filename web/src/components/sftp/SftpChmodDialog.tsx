"use client"

import * as React from "react"
import { toast } from "@/components/ui/sonner"
import { Button } from "@/components/ui/button"
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog"
import { Checkbox } from "@/components/ui/checkbox"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { sftpService, type SftpEntry } from "@/lib/api/services"

type Props = {
  nodeId: number
  entry: SftpEntry | null
  onClose: () => void
  onSaved?: () => void
}

const BITS = [
  { name: "owner", label: "所有者" },
  { name: "group", label: "用户组" },
  { name: "other", label: "其他" },
] as const

const PERMS = [
  { name: "r", label: "读", value: 4 },
  { name: "w", label: "写", value: 2 },
  { name: "x", label: "执行", value: 1 },
] as const

function modeStrFrom(perm: number): string {
  return perm.toString(8).padStart(4, "0")
}

function parseModeStr(s: string): number | null {
  const m = s.trim().replace(/^0+/, "") || "0"
  if (!/^[0-7]{1,4}$/.test(m)) return null
  const n = parseInt(m, 8)
  if (n > 0o7777) return null
  return n
}

export function SftpChmodDialog({ nodeId, entry, onClose, onSaved }: Props) {
  const initial = React.useMemo(() => {
    if (!entry) return 0o644
    if (entry.mode_octal) {
      const n = parseModeStr(entry.mode_octal)
      if (n != null) return n
    }
    return entry.is_dir ? 0o755 : 0o644
  }, [entry])
  const [mode, setMode] = React.useState(initial)
  const [text, setText] = React.useState(modeStrFrom(initial))
  const [saving, setSaving] = React.useState(false)

  React.useEffect(() => {
    setMode(initial)
    setText(modeStrFrom(initial))
  }, [initial])

  const setBit = (block: number, perm: number, on: boolean) => {
    const shift = (2 - block) * 3
    const bit = perm << shift
    const next = on ? mode | bit : mode & ~bit
    setMode(next)
    setText(modeStrFrom(next))
  }
  const isOn = (block: number, perm: number) => {
    const shift = (2 - block) * 3
    return ((mode >> shift) & perm) === perm
  }

  const onTextChange = (v: string) => {
    setText(v)
    const n = parseModeStr(v)
    if (n != null) setMode(n)
  }

  const onApply = async () => {
    if (!entry) return
    setSaving(true)
    try {
      await sftpService.chmod(nodeId, entry.path, mode)
      toast.success("权限已更新", { description: `${entry.name} → ${modeStrFrom(mode)}` })
      onSaved?.()
      onClose()
    } catch (e) {
      const err = e as { message?: string }
      toast.error("更新失败", { description: err?.message || String(e) })
    } finally {
      setSaving(false)
    }
  }

  return (
    <Dialog open={!!entry} onOpenChange={(v) => !v && onClose()}>
      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle>修改权限</DialogTitle>
          <DialogDescription className="truncate font-mono text-xs" title={entry?.path}>
            {entry?.path}
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-4 py-2">
          <div className="rounded-lg border p-3">
            <div className="grid grid-cols-[5rem_repeat(3,1fr)_2.5rem] items-center gap-y-2.5 text-sm">
              <span />
              {PERMS.map((p) => (
                <span key={p.name} className="text-center text-xs text-muted-foreground">
                  {p.label}
                </span>
              ))}
              <span className="text-center text-xs text-muted-foreground">值</span>
              {BITS.map((b, bi) => {
                const blockMode = (mode >> ((2 - bi) * 3)) & 0o7
                return (
                  <React.Fragment key={b.name}>
                    <span className="text-muted-foreground">{b.label}</span>
                    {PERMS.map((p) => (
                      <span key={p.name} className="flex justify-center">
                        <Checkbox
                          checked={isOn(bi, p.value)}
                          onCheckedChange={(v) => setBit(bi, p.value, v === true)}
                          aria-label={`${b.label} ${p.label}`}
                        />
                      </span>
                    ))}
                    <span className="text-center font-mono text-xs tabular-nums text-muted-foreground">
                      {blockMode}
                    </span>
                  </React.Fragment>
                )
              })}
            </div>
          </div>

          <div className="grid grid-cols-2 gap-3 items-end">
            <div className="space-y-1">
              <Label htmlFor="mode-octal" className="text-xs text-muted-foreground">
                八进制 (0–7777)
              </Label>
              <Input
                id="mode-octal"
                value={text}
                onChange={(e) => onTextChange(e.target.value)}
                className="font-mono h-9"
                spellCheck={false}
              />
            </div>
            <div className="space-y-1">
              <Label className="text-xs text-muted-foreground">符号</Label>
              <div className="h-9 px-3 border rounded-md flex items-center font-mono text-sm bg-muted/30">
                {symbolic(mode, entry?.is_dir, entry?.is_link)}
              </div>
            </div>
          </div>
        </div>

        <DialogFooter>
          <Button variant="outline" onClick={onClose} disabled={saving}>
            取消
          </Button>
          <Button onClick={() => void onApply()} disabled={saving || !entry || parseModeStr(text) == null}>
            {saving ? "保存中…" : "应用"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

function symbolic(mode: number, isDir?: boolean, isLink?: boolean): string {
  const tri = (m: number) => {
    return (m & 4 ? "r" : "-") + (m & 2 ? "w" : "-") + (m & 1 ? "x" : "-")
  }
  const head = isLink ? "l" : isDir ? "d" : "-"
  return head + tri((mode >> 6) & 7) + tri((mode >> 3) & 7) + tri(mode & 7)
}
