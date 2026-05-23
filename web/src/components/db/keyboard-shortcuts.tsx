"use client"

import * as React from "react"
import { Keyboard } from "lucide-react"
import { Button } from "@/components/ui/button"
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
} from "@/components/ui/dialog"

// KeyboardShortcuts — discoverable cheatsheet for DB Studio power-user
// keys. Triggered by either the toolbar button or the global `?` key
// (which works anywhere except inside an Input / Textarea / contenteditable
// so we don't hijack the user's typing).
//
// The shortcuts list is the source of truth — Monaco's keybindings get
// registered in SQLEditor's onMount; the modal here just documents
// them so the user can discover what's possible without reading code.
export function KeyboardShortcuts() {
  const [open, setOpen] = React.useState(false)

  // Global `?` keybind. We bail when the focused element is a text
  // input so typing literal "?" still works inside the editor / search
  // boxes.
  React.useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "?" && !(e.key === "/" && e.shiftKey)) return
      const t = e.target as HTMLElement | null
      const tag = t?.tagName?.toLowerCase()
      if (tag === "input" || tag === "textarea" || t?.isContentEditable) return
      e.preventDefault()
      setOpen((v) => !v)
    }
    window.addEventListener("keydown", onKey)
    return () => window.removeEventListener("keydown", onKey)
  }, [])

  return (
    <>
      <Button
        type="button"
        variant="ghost"
        size="sm"
        className="h-7 px-2 text-xs gap-1"
        onClick={() => setOpen(true)}
        title="键盘快捷键 (?)"
      >
        <Keyboard className="w-3.5 h-3.5" />
      </Button>
      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2">
              <Keyboard className="w-4 h-4" /> 键盘快捷键
            </DialogTitle>
            <DialogDescription>
              在 SQL 编辑器 / 表格 / 任意页面均可使用
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-3">
            <Section title="SQL 编辑器">
              <Row keys={["Ctrl/⌘", "Enter"]} desc="执行选中段；无选择则执行光标所在语句" />
              <Row keys={["Ctrl/⌘", "S"]} desc="保存到历史（不触发浏览器保存对话框）" />
              <Row keys={["Ctrl/⌘", "/"]} desc="切换行注释（Monaco 原生）" />
              <Row keys={["Alt", "↑"]} desc="向上移动当前行" />
              <Row keys={["Alt", "↓"]} desc="向下移动当前行" />
            </Section>
            <Section title="表格 / 浏览">
              <Row keys={["双击"]} desc="可编辑单元格 → 行内修改（回车保存 / Esc 取消）" />
              <Row keys={["单击"]} desc="复制单元格内容到剪贴板" />
              <Row keys={["点击表名"]} desc="切到 浏览 tab 加载该表" />
              <Row keys={["双击表名"]} desc="把限定标识符插入到 SQL 编辑器光标位置" />
            </Section>
            <Section title="全局">
              <Row keys={["?"]} desc="切换本面板（输入框内不生效）" />
              <Row keys={["Esc"]} desc="关闭模态 / 取消编辑" />
            </Section>
          </div>
          <div className="text-[10px] text-muted-foreground text-center pt-2 border-t">
            提示：Monaco 编辑器内还可以用 <kbd className="bg-muted px-1 py-0.5 rounded">F1</kbd> 打开命令面板
          </div>
        </DialogContent>
      </Dialog>
    </>
  )
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section>
      <h3 className="text-[11px] uppercase tracking-wider text-muted-foreground mb-1.5">
        {title}
      </h3>
      <div className="space-y-1">{children}</div>
    </section>
  )
}

function Row({ keys, desc }: { keys: string[]; desc: string }) {
  return (
    <div className="flex items-center gap-2 text-xs">
      <div className="flex items-center gap-1 shrink-0 min-w-[7rem]">
        {keys.map((k, i) => (
          <React.Fragment key={i}>
            {i > 0 && <span className="text-muted-foreground text-[10px]">+</span>}
            <kbd className="bg-muted border border-muted-foreground/20 rounded px-1.5 py-0.5 font-mono text-[10px]">
              {k}
            </kbd>
          </React.Fragment>
        ))}
      </div>
      <span className="text-muted-foreground">{desc}</span>
    </div>
  )
}
