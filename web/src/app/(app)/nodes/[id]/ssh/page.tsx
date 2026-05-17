"use client"

import * as React from "react"
import { use } from "react"
import { useQuery } from "@tanstack/react-query"
import { Group, Panel, Separator } from "react-resizable-panels"
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs"
import { InsightsPanel } from "@/components/insights/insights-panel"
import { WebSSHTerminal } from "@/components/terminal/webssh-terminal"
import { nodeService } from "@/lib/api/services"

export default function NodeSSHPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = use(params)
  const nodeId = Number(id)
  const node = useQuery({
    queryKey: ["node", nodeId],
    queryFn: () => nodeService.get(nodeId),
  })
  const [collapsed, setCollapsed] = React.useState(false)
  const [isWide, setIsWide] = React.useState(true)
  // Plan 14 — narrow screens get a tabbed layout instead of split panels,
  // matching the lg breakpoint Tailwind uses for sidebars (1024px).
  React.useEffect(() => {
    if (typeof window === "undefined") return
    const mq = window.matchMedia("(min-width: 1024px)")
    const update = () => setIsWide(mq.matches)
    update()
    mq.addEventListener("change", update)
    return () => mq.removeEventListener("change", update)
  }, [])

  const terminal = (
    <WebSSHTerminal
      protocol="ssh"
      nodeId={nodeId}
      displayName={node.data?.name}
      username={node.data?.username}
      host={node.data?.host}
      port={node.data?.port}
    />
  )

  if (!isWide) {
    return (
      <div className="h-[calc(100vh-56px)] w-full">
        <Tabs defaultValue="terminal" className="h-full flex flex-col">
          <TabsList className="mx-2 mt-2 h-9">
            <TabsTrigger value="terminal" className="text-xs">终端</TabsTrigger>
            <TabsTrigger value="insights" className="text-xs">系统仪表盘</TabsTrigger>
          </TabsList>
          <TabsContent value="terminal" className="flex-1 mt-0 min-h-0">
            {terminal}
          </TabsContent>
          <TabsContent value="insights" className="flex-1 mt-0 min-h-0">
            <InsightsPanel nodeId={nodeId} />
          </TabsContent>
        </Tabs>
      </div>
    )
  }

  // react-resizable-panels v4 exports Group / Panel / Separator (older v3
  // names PanelGroup / PanelResizeHandle were renamed). We use percentage
  // defaults; the Separator handles drag-resize.
  return (
    <div className="h-[calc(100vh-56px)] w-full">
      <Group orientation="horizontal" className="h-full">
        <Panel id="terminal" defaultSize="60%" minSize="30%">
          {terminal}
        </Panel>
        <Separator className="w-1 bg-border/30 hover:bg-primary/40 transition-colors" />
        <Panel
          id="insights"
          defaultSize="40%"
          minSize={collapsed ? "3%" : "20%"}
          maxSize={collapsed ? "3%" : "70%"}
        >
          <InsightsPanel
            nodeId={nodeId}
            collapsed={collapsed}
            onToggleCollapse={() => setCollapsed((c) => !c)}
          />
        </Panel>
      </Group>
    </div>
  )
}
