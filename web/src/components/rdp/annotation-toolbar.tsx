"use client"

// AnnotationToolbar — Plan 15. Floating panel that appears when annotation
// mode is on. Lets the user pick tool / colour / undo / redo / clear.

import * as React from "react"
import { motion, AnimatePresence } from "motion/react"
import {
  ArrowRight,
  Eraser,
  Highlighter,
  PencilLine,
  Redo2,
  Square as SquareIcon,
  Undo2,
} from "lucide-react"
import { Button } from "@/components/ui/button"
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip"
import { cn } from "@/lib/utils"

export type AnnotationTool = "pen" | "arrow" | "rectangle" | "highlight"

const COLORS: { name: string; hex: number; css: string }[] = [
  { name: "红", hex: 0xef4444, css: "#ef4444" },
  { name: "黄", hex: 0xeab308, css: "#eab308" },
  { name: "绿", hex: 0x10b981, css: "#10b981" },
  { name: "蓝", hex: 0x3b82f6, css: "#3b82f6" },
  { name: "紫", hex: 0xa855f7, css: "#a855f7" },
  { name: "白", hex: 0xffffff, css: "#ffffff" },
]

export interface AnnotationToolbarProps {
  visible: boolean
  tool: AnnotationTool
  color: number
  onToolChange(t: AnnotationTool): void
  onColorChange(hex: number): void
  onUndo(): void
  onRedo(): void
  onClear(): void
  onClose(): void
}

export function AnnotationToolbar(props: AnnotationToolbarProps) {
  return (
    <AnimatePresence>
      {props.visible && (
        <motion.div
          initial={{ y: 32, opacity: 0 }}
          animate={{ y: 0, opacity: 1 }}
          exit={{ y: 32, opacity: 0 }}
          transition={{ type: "spring", stiffness: 380, damping: 32 }}
          className="absolute top-32 left-1/2 -translate-x-1/2 z-30 flex items-center gap-1 px-2 py-1.5 bg-background/90 backdrop-blur border border-border/60 rounded-lg shadow-lg"
        >
          <ToolBtn
            title="自由笔"
            active={props.tool === "pen"}
            onClick={() => props.onToolChange("pen")}
            icon={PencilLine}
          />
          <ToolBtn
            title="箭头"
            active={props.tool === "arrow"}
            onClick={() => props.onToolChange("arrow")}
            icon={ArrowRight}
          />
          <ToolBtn
            title="矩形"
            active={props.tool === "rectangle"}
            onClick={() => props.onToolChange("rectangle")}
            icon={SquareIcon}
          />
          <ToolBtn
            title="高亮笔"
            active={props.tool === "highlight"}
            onClick={() => props.onToolChange("highlight")}
            icon={Highlighter}
          />
          <div className="w-px h-5 bg-border/60 mx-0.5" />
          <div className="flex items-center gap-1 px-1">
            {COLORS.map((c) => (
              <Tooltip key={c.hex}>
                <TooltipTrigger asChild>
                  <button
                    type="button"
                    aria-label={c.name}
                    onClick={() => props.onColorChange(c.hex)}
                    className={cn(
                      "w-4 h-4 rounded-full border border-border/60 ring-offset-1 ring-offset-background transition",
                      props.color === c.hex && "ring-2 ring-primary",
                    )}
                    style={{ backgroundColor: c.css }}
                  />
                </TooltipTrigger>
                <TooltipContent side="bottom">{c.name}</TooltipContent>
              </Tooltip>
            ))}
          </div>
          <div className="w-px h-5 bg-border/60 mx-0.5" />
          <ToolBtn title="撤销" onClick={props.onUndo} icon={Undo2} />
          <ToolBtn title="重做" onClick={props.onRedo} icon={Redo2} />
          <ToolBtn
            title="清除全部"
            onClick={props.onClear}
            icon={Eraser}
            danger
          />
          <div className="w-px h-5 bg-border/60 mx-0.5" />
          <Button
            type="button"
            variant="ghost"
            size="sm"
            className="h-7 px-2 text-xs"
            onClick={props.onClose}
          >
            关闭
          </Button>
        </motion.div>
      )}
    </AnimatePresence>
  )
}

function ToolBtn({
  title,
  onClick,
  icon: Icon,
  active,
  danger,
}: {
  title: string
  onClick: () => void
  icon: React.ComponentType<{ className?: string }>
  active?: boolean
  danger?: boolean
}) {
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <Button
          type="button"
          variant={active ? "secondary" : "ghost"}
          size="icon"
          className={cn("h-7 w-7", danger && "text-destructive hover:text-destructive")}
          onClick={onClick}
          aria-label={title}
        >
          <Icon className="w-3.5 h-3.5" />
        </Button>
      </TooltipTrigger>
      <TooltipContent side="bottom">{title}</TooltipContent>
    </Tooltip>
  )
}
