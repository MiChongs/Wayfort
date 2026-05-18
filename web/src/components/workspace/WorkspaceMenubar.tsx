"use client"

import * as React from "react"
import { useRouter } from "next/navigation"
import { useTheme } from "next-themes"
import { LayoutGrid, LogOut, Moon, Sun, SunMoon } from "lucide-react"
import { toast } from "sonner"
import {
  Menubar,
  MenubarContent,
  MenubarItem,
  MenubarMenu,
  MenubarRadioGroup,
  MenubarRadioItem,
  MenubarSeparator,
  MenubarShortcut,
  MenubarTrigger,
} from "@/components/ui/menubar"
import { authService } from "@/lib/api/services"
import { clearTokens } from "@/lib/auth/tokens"
import { useWorkspaceStore } from "./useWorkspaceStore"

type Props = {
  onNewTab: () => void
  onShowShortcuts: () => void
}

const VERSION = process.env.NEXT_PUBLIC_APP_VERSION || "dev"

export function WorkspaceMenubar({ onNewTab, onShowShortcuts }: Props) {
  const router = useRouter()
  const { theme, setTheme } = useTheme()
  const tabs = useWorkspaceStore((s) => s.tabs)
  const activeId = useWorkspaceStore((s) => s.activeId)
  const close = useWorkspaceStore((s) => s.close)
  const closeAll = useWorkspaceStore((s) => s.closeAll)
  const duplicate = useWorkspaceStore((s) => s.duplicate)
  const cycleTab = useWorkspaceStore((s) => s.cycleTab)
  const toggleSidebar = useWorkspaceStore((s) => s.toggleSidebar)

  const onLogout = async () => {
    try {
      await authService.logout()
    } catch {
      // backend already invalidated token or unreachable — clear locally either way
    }
    clearTokens()
    router.replace("/login")
  }

  const fullscreenCurrent = () => {
    if (!activeId) return
    const el = document.querySelector<HTMLElement>(`[role="tabpanel"][aria-hidden="false"]`)
    if (!el) return
    if (document.fullscreenElement) void document.exitFullscreen()
    else void el.requestFullscreen?.().catch(() => toast.error("无法进入全屏"))
  }

  return (
    <div className="flex items-center justify-between gap-3 px-2 py-1.5 border-b bg-background shrink-0">
      <div className="flex items-center gap-2 shrink-0">
        <LayoutGrid className="w-5 h-5 text-primary" />
        <span className="text-sm font-semibold tracking-tight">工作台</span>
      </div>
      <Menubar className="border-0 shadow-none">
        <MenubarMenu>
          <MenubarTrigger>文件</MenubarTrigger>
          <MenubarContent>
            <MenubarItem onSelect={onNewTab}>
              新建连接
              <MenubarShortcut>Ctrl+T</MenubarShortcut>
            </MenubarItem>
            <MenubarItem
              onSelect={() => activeId && duplicate(activeId)}
              disabled={!activeId}
            >
              复制当前 Tab
            </MenubarItem>
            <MenubarSeparator />
            <MenubarItem
              onSelect={() => activeId && close(activeId)}
              disabled={!activeId}
            >
              关闭当前 Tab
              <MenubarShortcut>Ctrl+W</MenubarShortcut>
            </MenubarItem>
            <MenubarItem onSelect={closeAll} disabled={tabs.length === 0}>
              关闭全部 Tab
            </MenubarItem>
            <MenubarSeparator />
            <MenubarItem onSelect={onLogout}>
              <LogOut className="w-4 h-4" /> 退出登录
            </MenubarItem>
          </MenubarContent>
        </MenubarMenu>
        <MenubarMenu>
          <MenubarTrigger>视图</MenubarTrigger>
          <MenubarContent>
            <MenubarItem onSelect={toggleSidebar}>
              切换侧边栏
              <MenubarShortcut>Ctrl+B</MenubarShortcut>
            </MenubarItem>
            <MenubarSeparator />
            <MenubarItem onSelect={() => cycleTab(1)} disabled={tabs.length < 2}>
              下一个 Tab
              <MenubarShortcut>Ctrl+Tab</MenubarShortcut>
            </MenubarItem>
            <MenubarItem onSelect={() => cycleTab(-1)} disabled={tabs.length < 2}>
              上一个 Tab
              <MenubarShortcut>Ctrl+Shift+Tab</MenubarShortcut>
            </MenubarItem>
            <MenubarSeparator />
            <MenubarItem onSelect={fullscreenCurrent} disabled={!activeId}>
              全屏当前 Tab
              <MenubarShortcut>F11</MenubarShortcut>
            </MenubarItem>
          </MenubarContent>
        </MenubarMenu>
        <MenubarMenu>
          <MenubarTrigger>主题</MenubarTrigger>
          <MenubarContent>
            <MenubarRadioGroup value={theme ?? "system"} onValueChange={setTheme}>
              <MenubarRadioItem value="light">
                <Sun className="w-4 h-4 mr-2" /> 明亮
              </MenubarRadioItem>
              <MenubarRadioItem value="dark">
                <Moon className="w-4 h-4 mr-2" /> 暗色
              </MenubarRadioItem>
              <MenubarRadioItem value="system">
                <SunMoon className="w-4 h-4 mr-2" /> 跟随系统
              </MenubarRadioItem>
            </MenubarRadioGroup>
          </MenubarContent>
        </MenubarMenu>
        <MenubarMenu>
          <MenubarTrigger>帮助</MenubarTrigger>
          <MenubarContent>
            <MenubarItem onSelect={onShowShortcuts}>键盘快捷键</MenubarItem>
            <MenubarItem
              onSelect={() =>
                window.open(
                  "https://github.com/MiChongs/JumpServer-Anonymous",
                  "_blank",
                  "noopener,noreferrer",
                )
              }
            >
              文档 / 仓库
            </MenubarItem>
            <MenubarSeparator />
            <MenubarItem disabled>版本 {VERSION}</MenubarItem>
          </MenubarContent>
        </MenubarMenu>
      </Menubar>
      <div className="flex-1" />
    </div>
  )
}
