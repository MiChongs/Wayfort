"use client"

import * as React from "react"
import { InsightsPanel } from "@/components/insights/insights-panel"

type Props = {
  nodeId: number
}

// DashboardTab wraps the existing InsightsPanel. Setting `collapsed={false}`
// gives us the full tabs (Overview/Processes/Network/Disks); the outer
// react-resizable-panels Panel handles the visual collapse independently.
export function DashboardTab({ nodeId }: Props) {
  return <InsightsPanel nodeId={nodeId} collapsed={false} />
}
