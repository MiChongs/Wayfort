"use client"

import * as React from "react"
import { FilePlus, FolderPlus } from "lucide-react"
import { Button } from "@/components/ui/button"
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"

type Props = {
  open: boolean
  kind: "folder" | "file"
  parentPath: string
  busy?: boolean
  onCancel: () => void
  onSubmit: (name: string) => void
}

const INVALID = /[/\\\0]/

export function SftpCreateDialog({ open, kind, parentPath, busy, onCancel, onSubmit }: Props) {
  const [name, setName] = React.useState("")
  const ref = React.useRef<HTMLInputElement>(null)

  React.useEffect(() => {
    if (!open) return
    setName("")
    const t = setTimeout(() => ref.current?.focus(), 0)
    return () => clearTimeout(t)
  }, [open])

  const trimmed = name.trim()
  const invalid = trimmed === "" || INVALID.test(trimmed) || trimmed === "." || trimmed === ".."

  const submit = () => {
    if (invalid || busy) return
    onSubmit(trimmed)
  }

  return (
    <Dialog open={open} onOpenChange={(v) => !v && onCancel()}>
      <DialogContent className="max-w-sm">
        <DialogHeader>
          <DialogTitle className="inline-flex items-center gap-2">
            {kind === "folder" ? <FolderPlus className="w-4 h-4" /> : <FilePlus className="w-4 h-4" />}
            新建{kind === "folder" ? "目录" : "文件"}
          </DialogTitle>
          <DialogDescription className="font-mono text-xs truncate" title={parentPath}>
            将在 {parentPath} 下创建
          </DialogDescription>
        </DialogHeader>
        <div className="space-y-2 py-1">
          <Label htmlFor="sftp-create-name" className="text-xs text-muted-foreground">
            名称
          </Label>
          <Input
            id="sftp-create-name"
            ref={ref}
            value={name}
            onChange={(e) => setName(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") {
                e.preventDefault()
                submit()
              }
              if (e.key === "Escape") {
                e.preventDefault()
                onCancel()
              }
            }}
            placeholder={kind === "folder" ? "例如 logs" : "例如 notes.md"}
            spellCheck={false}
            autoComplete="off"
          />
          {name && invalid && (
            <p className="text-xs text-destructive">名称不能为空、包含 / \ 或为 . / ..</p>
          )}
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={onCancel} disabled={busy}>
            取消
          </Button>
          <Button onClick={submit} disabled={invalid || busy}>
            {busy ? "创建中…" : "创建"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
