"use client"

import * as React from "react"
import { Virtuoso } from "react-virtuoso"

/**
 * MaybeVirtualList renders a list normally when short (so entrance animations
 * and sticky behaviour are preserved) and switches to a virtualised Virtuoso
 * list once it crosses `threshold`, keeping long ops/tool lists smooth. The
 * virtualised branch needs a bounded height, supplied via `height`.
 */
export function MaybeVirtualList<T>({
  items,
  threshold = 30,
  height = "min(60vh, 28rem)",
  renderItem,
  className,
  itemKey,
}: {
  items: T[]
  threshold?: number
  height?: string
  renderItem: (item: T, index: number) => React.ReactNode
  className?: string
  itemKey?: (item: T, index: number) => React.Key
}) {
  if (items.length <= threshold) {
    return (
      <div className={className}>
        {items.map((it, i) => (
          <React.Fragment key={itemKey ? itemKey(it, i) : i}>{renderItem(it, i)}</React.Fragment>
        ))}
      </div>
    )
  }
  return (
    <div style={{ height }}>
      <Virtuoso
        data={items}
        className="no-scrollbar"
        itemContent={(i, it) => renderItem(it, i)}
      />
    </div>
  )
}
