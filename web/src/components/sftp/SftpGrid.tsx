"use client"

import * as React from "react"
import { cn } from "@/lib/utils"
import { fmtBytes, relTime } from "@/lib/format"
import { sftpService, type SftpEntry, type SftpSearchHit } from "@/lib/api/services"
import { Checkbox } from "@/components/ui/checkbox"
import { iconColorForEntry, iconForEntry, isPreviewableImage } from "./fileIcons"
import { SftpRowContextMenu, type SftpContextActions } from "./SftpContextMenu"
import { readMovePayload, SFTP_MOVE_MIME } from "./sftpDnd"

const THUMB_MAX = 3 * 1024 * 1024 // only fetch a preview for images under 3 MiB

type Props = {
  nodeId: number
  entries: (SftpEntry | SftpSearchHit)[]
  isSelected: (path: string) => boolean
  selectedPaths: string[]
  onToggleRow: (entry: SftpEntry, index: number) => void
  onRowClick: (entry: SftpEntry, index: number, ev: React.MouseEvent) => void
  onRowDoubleClick: (entry: SftpEntry) => void
  contextActions: SftpContextActions
  onBeforeContextMenu?: (entry: SftpEntry) => void
  onMove: (paths: string[], targetDir: string) => void
  canWrite: boolean
  canThumbnail: boolean
}

// Grid view — cards with real image thumbnails (when downloads are unlocked),
// big type-coloured glyphs otherwise. Shares selection / drag-move / context
// semantics with the list so switching views never changes behaviour.
export function SftpGrid({
  nodeId,
  entries,
  isSelected,
  selectedPaths,
  onToggleRow,
  onRowClick,
  onRowDoubleClick,
  contextActions,
  onBeforeContextMenu,
  onMove,
  canWrite,
  canThumbnail,
}: Props) {
  return (
    <div className="grid grid-cols-[repeat(auto-fill,minmax(132px,1fr))] gap-2.5 p-3">
      {entries.map((e, i) => (
        <Card
          key={(e as SftpSearchHit).dir ? `${(e as SftpSearchHit).dir}/${e.name}` : e.path}
          nodeId={nodeId}
          entry={e}
          index={i}
          selected={isSelected(e.path)}
          selectedPaths={selectedPaths}
          canWrite={canWrite}
          canThumbnail={canThumbnail}
          contextActions={contextActions}
          onBeforeContextMenu={onBeforeContextMenu}
          onToggleRow={onToggleRow}
          onRowClick={onRowClick}
          onRowDoubleClick={onRowDoubleClick}
          onMove={onMove}
        />
      ))}
    </div>
  )
}

function Card({
  nodeId,
  entry,
  index,
  selected,
  selectedPaths,
  canWrite,
  canThumbnail,
  contextActions,
  onBeforeContextMenu,
  onToggleRow,
  onRowClick,
  onRowDoubleClick,
  onMove,
}: {
  nodeId: number
  entry: SftpEntry | SftpSearchHit
  index: number
  selected: boolean
  selectedPaths: string[]
  canWrite: boolean
  canThumbnail: boolean
  contextActions: SftpContextActions
  onBeforeContextMenu?: (e: SftpEntry) => void
  onToggleRow: (e: SftpEntry, index: number) => void
  onRowClick: (e: SftpEntry, index: number, ev: React.MouseEvent) => void
  onRowDoubleClick: (e: SftpEntry) => void
  onMove: (paths: string[], targetDir: string) => void
}) {
  const Icon = iconForEntry(entry)
  const [dropOver, setDropOver] = React.useState(false)
  const [imgFailed, setImgFailed] = React.useState(false)
  const acceptsDrop = entry.is_dir && canWrite
  const showThumb =
    canThumbnail && !imgFailed && isPreviewableImage(entry) && entry.size > 0 && entry.size <= THUMB_MAX

  return (
    <SftpRowContextMenu entry={entry} actions={contextActions} onBeforeOpen={onBeforeContextMenu}>
      <div
        role="gridcell"
        draggable={canWrite}
        onClick={(ev) => onRowClick(entry, index, ev)}
        onDoubleClick={() => onRowDoubleClick(entry)}
        onDragStart={(ev) => {
          const paths = selected && selectedPaths.length > 1 ? selectedPaths : [entry.path]
          ev.dataTransfer.setData(SFTP_MOVE_MIME, JSON.stringify({ paths }))
          ev.dataTransfer.effectAllowed = "move"
        }}
        onDragOver={(ev) => {
          if (!acceptsDrop || !ev.dataTransfer.types.includes(SFTP_MOVE_MIME)) return
          ev.preventDefault()
          ev.dataTransfer.dropEffect = "move"
          setDropOver(true)
        }}
        onDragLeave={() => setDropOver(false)}
        onDrop={(ev) => {
          setDropOver(false)
          if (!acceptsDrop) return
          const paths = readMovePayload(ev.dataTransfer)
          if (!paths || paths.includes(entry.path)) return
          ev.preventDefault()
          ev.stopPropagation()
          onMove(paths, entry.path)
        }}
        className={cn(
          "group relative flex cursor-default flex-col gap-1.5 rounded-xl border p-2 transition-colors",
          selected ? "border-primary/40 bg-primary/[0.06]" : "border-transparent hover:bg-accent/40",
          dropOver && "border-primary bg-primary/5 ring-1 ring-inset ring-primary",
        )}
      >
        <span
          className={cn(
            "absolute left-3 top-3 z-10",
            selected ? "opacity-100" : "opacity-0 transition-opacity group-hover:opacity-100",
          )}
        >
          <Checkbox
            checked={selected}
            onCheckedChange={() => onToggleRow(entry, index)}
            onClick={(e) => e.stopPropagation()}
            aria-label={`选择 ${entry.name}`}
            className="bg-card"
          />
        </span>

        <div className="grid aspect-square place-items-center overflow-hidden rounded-lg bg-muted/50">
          {showThumb ? (
            // eslint-disable-next-line @next/next/no-img-element
            <img
              src={sftpService.downloadURL(nodeId, entry.path)}
              alt={entry.name}
              loading="lazy"
              onError={() => setImgFailed(true)}
              className="h-full w-full object-cover"
            />
          ) : (
            <Icon className={cn("h-12 w-12", iconColorForEntry(entry))} />
          )}
        </div>

        <div className="min-w-0 px-0.5">
          <div className={cn("truncate text-[13px]", entry.is_dir && "font-medium")} title={entry.name}>
            {entry.name}
          </div>
          <div className="truncate text-[11px] text-muted-foreground">
            {entry.is_dir ? "目录" : fmtBytes(entry.size)} · {relTime(entry.mod_time)}
          </div>
        </div>
      </div>
    </SftpRowContextMenu>
  )
}
