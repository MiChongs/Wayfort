"use client"

import * as React from "react"
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs"
import type { PlanNode } from "@/lib/api/types"
import { PlanTree } from "./plan-tree"
import { PlanJson } from "./plan-json"
import { PlanStats } from "./plan-stats"

// ExecutionPlan renders the result of POST /db/plan as four tabs:
//   Tree  — normalised tree with per-node cost heat-map
//   JSON  — raw structured payload (debugging / copy-paste)
//   Text  — the engine's native EXPLAIN text (what the planner parsed)
//   Stats — operator-frequency rollup (spot sequential scans / sorts at scale)
//
// The component is presentational: it never calls the API itself. The parent
// (sql-editor) owns the plan result and passes it down, so a stale plan stays
// visible while a new one is in flight.
interface Props {
  root: PlanNode | null
  raw: string
}

export function ExecutionPlan({ root, raw }: Props) {
  const [tab, setTab] = React.useState<string>(root ? "tree" : "text")
  return (
    <Tabs value={tab} onValueChange={setTab} className="h-full flex flex-col">
      <TabsList className="w-full justify-start">
        <TabsTrigger value="tree" disabled={!root}>树</TabsTrigger>
        <TabsTrigger value="json" disabled={!root}>JSON</TabsTrigger>
        <TabsTrigger value="text">文本</TabsTrigger>
        <TabsTrigger value="stats" disabled={!root}>统计</TabsTrigger>
      </TabsList>
      <TabsContent value="tree" className="flex-1 min-h-0 overflow-auto">
        {root ? <PlanTree root={root} /> : <Empty />}
      </TabsContent>
      <TabsContent value="json" className="flex-1 min-h-0 overflow-auto">
        {root ? <PlanJson root={root} /> : <Empty />}
      </TabsContent>
      <TabsContent value="text" className="flex-1 min-h-0 overflow-auto">
        {raw.trim() ? (
          <pre className="text-[11px] leading-relaxed font-mono whitespace-pre-wrap p-2">{raw}</pre>
        ) : (
          <Empty />
        )}
      </TabsContent>
      <TabsContent value="stats" className="flex-1 min-h-0 overflow-auto">
        {root ? <PlanStats root={root} /> : <Empty />}
      </TabsContent>
    </Tabs>
  )
}

function Empty() {
  return (
    <div className="h-full grid place-items-center text-xs text-muted-foreground p-4 text-center">
      没有执行计划数据
    </div>
  )
}
