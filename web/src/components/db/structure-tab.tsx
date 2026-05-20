"use client"

import * as React from "react"
import dynamic from "next/dynamic"
import { useQuery } from "@tanstack/react-query"
import { ArrowRight, Database, FileCode, Hash, KeyRound, Link2, Loader2 } from "lucide-react"
import { Badge } from "@/components/ui/badge"
import { ScrollArea } from "@/components/ui/scroll-area"
import { dbService } from "@/lib/api/services"
import type { DBForeignKeyInfo, DBTableInfo } from "@/lib/api/types"
import { cn } from "@/lib/utils"

// Monaco for read-only DDL viewing. Same lazy-load pattern as the SQL editor.
const Monaco = dynamic(() => import("@monaco-editor/react").then((m) => m.default), {
  ssr: false,
  loading: () => (
    <div className="h-full grid place-items-center text-xs text-muted-foreground">
      <Loader2 className="w-4 h-4 animate-spin" />
    </div>
  ),
})

type Props = {
  nodeId: number
  database?: string
  table: DBTableInfo
}

// StructureTab — the "what does this table look like" view. Stats up top,
// then a 2-column body: CREATE statement on the left (Monaco read-only),
// FKs / indexes / columns summary on the right.
export function StructureTab({ nodeId, database, table }: Props) {
  const stats = useQuery({
    queryKey: ["db.stats", nodeId, database, table.schema, table.name],
    queryFn: () => dbService.stats(nodeId, table.schema, table.name, database),
    staleTime: 30_000,
  })
  const ddl = useQuery({
    queryKey: ["db.ddl", nodeId, database, table.schema, table.name],
    queryFn: () => dbService.ddl(nodeId, table.schema, table.name, database),
    staleTime: 30_000,
  })
  const fks = useQuery({
    queryKey: ["db.fk", nodeId, database, table.schema, table.name],
    queryFn: () => dbService.foreignKeys(nodeId, table.schema, table.name, database),
    staleTime: 30_000,
  })
  const cols = useQuery({
    queryKey: ["db.cols", nodeId, database, table.schema, table.name],
    queryFn: () => dbService.columns(nodeId, table.schema, table.name, database),
    staleTime: 60_000,
  })
  const indexes = useQuery({
    queryKey: ["db.idx", nodeId, database, table.schema, table.name],
    queryFn: () => dbService.indexes(nodeId, table.schema, table.name, database),
    staleTime: 60_000,
  })

  const out = fks.data?.foreign_keys.filter((f) => f.direction === "out") ?? []
  const inb = fks.data?.foreign_keys.filter((f) => f.direction === "in") ?? []

  return (
    <div className="flex flex-col h-full">
      <div className="border-b px-3 py-2 flex items-center gap-2 text-xs">
        {stats.data ? (
          <>
            <Badge variant="outline" className="font-mono">
              ≈{stats.data.rows_approx.toLocaleString()} 行
            </Badge>
            <Badge variant="outline" className="font-mono">
              {formatBytes(stats.data.total_bytes)} (数据 {formatBytes(stats.data.data_bytes)} · 索引 {formatBytes(stats.data.index_bytes)})
            </Badge>
            {stats.data.engine && (
              <Badge variant="secondary" className="font-mono text-[10px]">
                {stats.data.engine}
              </Badge>
            )}
          </>
        ) : (
          <span className="text-muted-foreground">{stats.isLoading ? "加载统计…" : "无统计"}</span>
        )}
      </div>

      <div className="flex flex-1 min-h-0">
        <div className="flex-1 min-w-0 flex flex-col border-r">
          <div className="border-b px-3 py-1.5 text-xs text-muted-foreground flex items-center gap-1.5">
            <FileCode className="w-3.5 h-3.5" /> CREATE 语句
          </div>
          <div className="flex-1 min-h-0">
            {ddl.isLoading ? (
              <div className="h-full grid place-items-center text-xs text-muted-foreground">
                <Loader2 className="w-4 h-4 animate-spin" />
              </div>
            ) : ddl.error ? (
              <pre className="m-3 rounded-md border border-destructive/40 bg-destructive/5 p-3 text-xs font-mono whitespace-pre-wrap">
                {(ddl.error as { message?: string }).message ?? "load failed"}
              </pre>
            ) : (
              <Monaco
                height="100%"
                defaultLanguage="sql"
                theme="vs"
                value={ddl.data?.ddl ?? ""}
                options={{
                  readOnly: true,
                  minimap: { enabled: false },
                  fontSize: 12,
                  scrollBeyondLastLine: false,
                  wordWrap: "on",
                  renderLineHighlight: "none",
                  padding: { top: 8 },
                }}
              />
            )}
          </div>
        </div>

        <ScrollArea className="w-80 shrink-0 bg-card/30">
          <Section title="列" icon={<Database className="w-3.5 h-3.5" />}>
            {cols.data?.columns.length === 0 && <Empty />}
            <ul className="space-y-0.5">
              {cols.data?.columns.map((c) => (
                <li key={c.name} className="text-xs flex items-baseline gap-1.5">
                  {c.is_primary_key && <KeyRound className="w-2.5 h-2.5 text-amber-600 shrink-0 self-center" />}
                  <span className="font-medium truncate">{c.name}</span>
                  <span className="text-[10px] text-muted-foreground font-mono ml-auto">{c.type}</span>
                  {!c.nullable && (
                    <span className="text-[9px] uppercase text-muted-foreground">NN</span>
                  )}
                </li>
              ))}
            </ul>
          </Section>

          <Section title="索引" icon={<Hash className="w-3.5 h-3.5" />}>
            {indexes.data?.indexes.length === 0 && <Empty />}
            <ul className="space-y-1.5">
              {indexes.data?.indexes.map((idx) => (
                <li key={idx.name} className="text-xs">
                  <div className="flex items-center gap-1.5">
                    <span className="font-medium truncate">{idx.name}</span>
                    {idx.is_primary && <Badge variant="secondary" className="text-[9px] px-1 py-0">PK</Badge>}
                    {idx.is_unique && !idx.is_primary && (
                      <Badge variant="outline" className="text-[9px] px-1 py-0">UNIQUE</Badge>
                    )}
                  </div>
                  <div className="text-[10px] text-muted-foreground font-mono">
                    ({idx.columns.join(", ")})
                  </div>
                </li>
              ))}
            </ul>
          </Section>

          <Section title="外键（出）" icon={<Link2 className="w-3.5 h-3.5" />} subtitle="本表 → 其它表">
            {out.length === 0 && <Empty />}
            <ul className="space-y-1.5">
              {out.map((f) => (
                <FKItem key={f.name} fk={f} side="from" />
              ))}
            </ul>
          </Section>

          <Section title="外键（入）" icon={<Link2 className="w-3.5 h-3.5 rotate-180" />} subtitle="其它表 → 本表">
            {inb.length === 0 && <Empty />}
            <ul className="space-y-1.5">
              {inb.map((f) => (
                <FKItem key={f.name} fk={f} side="to" />
              ))}
            </ul>
          </Section>
        </ScrollArea>
      </div>
    </div>
  )
}

function Section({
  title,
  icon,
  subtitle,
  children,
}: {
  title: string
  icon: React.ReactNode
  subtitle?: string
  children: React.ReactNode
}) {
  return (
    <section className="p-3 border-b last:border-b-0">
      <div className="text-xs font-medium mb-1.5 flex items-center gap-1.5">
        {icon}
        {title}
        {subtitle && <span className="text-[10px] text-muted-foreground font-normal">{subtitle}</span>}
      </div>
      {children}
    </section>
  )
}

function Empty() {
  return <div className="text-[10px] text-muted-foreground">无</div>
}

function FKItem({ fk, side }: { fk: DBForeignKeyInfo; side: "from" | "to" }) {
  return (
    <li className="text-xs">
      <div className="font-medium truncate">{fk.name}</div>
      <div className="flex items-center gap-1 text-[10px] font-mono text-muted-foreground">
        <span className={cn(side === "from" ? "text-foreground" : undefined)}>
          {fk.from_columns.join(",")}
        </span>
        <ArrowRight className="w-2.5 h-2.5" />
        <span className={cn(side === "to" ? "text-foreground" : undefined)}>
          {fk.to_schema}.{fk.to_table}
          <span className="text-muted-foreground"> ({fk.to_columns.join(",")})</span>
        </span>
      </div>
      {(fk.on_update !== "NO ACTION" || fk.on_delete !== "NO ACTION") && (
        <div className="text-[9px] text-muted-foreground mt-0.5">
          ON UPDATE {fk.on_update} · ON DELETE {fk.on_delete}
        </div>
      )}
    </li>
  )
}

function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`
  if (n < 1024 * 1024 * 1024) return `${(n / 1024 / 1024).toFixed(1)} MB`
  return `${(n / 1024 / 1024 / 1024).toFixed(2)} GB`
}
