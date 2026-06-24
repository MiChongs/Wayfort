"use client"

import { useState } from "react"
import { useQuery } from "@tanstack/react-query"
import { Download, Loader2 } from "lucide-react"
import { Bar, BarChart, CartesianGrid, ResponsiveContainer, Tooltip, XAxis, YAxis } from "recharts"
import { dbService } from "@/lib/api/services"
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
} from "@/components/ui/sheet"
import { Button } from "@/components/ui/button"
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select"

interface ColumnRef {
  name: string
  dataType: string
}

interface Props {
  open: boolean
  onClose: () => void
  nodeId: number
  schema: string
  table: string
  database?: string
  columns: ColumnRef[]
}

// DataProfiling — Phase 2C.5. Side Sheet that, for a chosen column, shows
// basic stats (count/distinct/null/min/max/avg/stddev), a 20-bucket numeric
// distribution, Top-10 frequent values, and regex pattern hits
// (email/phone/uuid/ipv4). Results export to Markdown for incident notes.
export function DataProfiling({ open, onClose, nodeId, schema, table, database, columns }: Props) {
  const [column, setColumn] = useState(columns[0]?.name ?? "")
  const params = { schema, table, column, database }

  const stats = useQuery({
    queryKey: ["profile-stats", nodeId, database ?? "", schema, table, column],
    queryFn: () => dbService.profile.stats(nodeId, params),
    enabled: open && !!column,
  })
  const distribution = useQuery({
    queryKey: ["profile-dist", nodeId, database ?? "", schema, table, column],
    queryFn: () => dbService.profile.distribution(nodeId, { ...params, buckets: 20 }),
    enabled: open && !!column,
  })
  const topn = useQuery({
    queryKey: ["profile-topn", nodeId, database ?? "", schema, table, column],
    queryFn: () => dbService.profile.topn(nodeId, { ...params, n: 10 }).then((r) => r.items),
    enabled: open && !!column,
  })
  const patterns = useQuery({
    queryKey: ["profile-patterns", nodeId, database ?? "", schema, table, column],
    queryFn: () => dbService.profile.patterns(nodeId, params).then((r) => r.items),
    enabled: open && !!column,
  })

  function exportMarkdown() {
    const s = stats.data
    const md = [
      `# 数据剖析：${schema}.${table}.${column}`,
      ``,
      `## 基本统计`,
      `- 行数 (Count)：${fmt(s?.Count)}`,
      `- 非重复值 (Distinct)：${fmt(s?.Distinct)}`,
      `- NULL 数 (NullCount)：${fmt(s?.NullCount)}`,
      `- 最小 / 最大 (Min/Max)：${fmt(s?.Min)} / ${fmt(s?.Max)}`,
      `- 均值 / 标准差 (Avg/StdDev)：${num(s?.Avg)} / ${num(s?.StdDev)}`,
      ``,
      `## Top 10 高频值`,
      ...(topn.data ?? []).map((t) => `- ${fmt(t.Value)}：${t.Count}`),
      ``,
      `## 正则模式匹配`,
      ...(patterns.data ?? []).map((p) => `- ${p.Pattern}：${p.Count}`),
    ].join("\n")
    const blob = new Blob([md], { type: "text/markdown;charset=utf-8" })
    const a = document.createElement("a")
    a.href = URL.createObjectURL(blob)
    a.download = `profile-${schema}-${table}-${column}.md`
    a.click()
    URL.revokeObjectURL(a.href)
  }

  const distData = (distribution.data?.Buckets ?? []).map((b, i) => ({
    idx: i + 1,
    count: b.Count,
  }))
  const topData = (topn.data ?? []).map((t) => ({ name: fmt(t.Value), count: t.Count }))

  return (
    <Sheet open={open} onOpenChange={(o) => !o && onClose()}>
      <SheetContent className="w-[760px] sm:max-w-[760px] overflow-y-auto">
        <SheetHeader>
          <SheetTitle>
            数据剖析 — <span className="font-mono">{schema}.{table}</span>
          </SheetTitle>
          <SheetDescription>
            选取一列查看基本统计 / 数值分布 / Top-N 高频值 / 正则模式（邮箱、手机号、UUID、IPv4 等）。
          </SheetDescription>
        </SheetHeader>

        <div className="flex items-center gap-2 mt-3">
          <Select value={column} onValueChange={setColumn}>
            <SelectTrigger className="w-56">
              <SelectValue placeholder="选择列" />
            </SelectTrigger>
            <SelectContent>
              {columns.map((c) => (
                <SelectItem key={c.name} value={c.name}>
                  {c.name} <span className="text-xs text-muted-foreground">({c.dataType})</span>
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          <Button variant="ghost" size="sm" className="gap-1" onClick={exportMarkdown} disabled={!column}>
            <Download className="w-3.5 h-3.5" /> 导出 Markdown
          </Button>
        </div>

        <Section title="基本统计">
          {stats.isLoading ? (
            <Loading />
          ) : stats.data ? (
            <table className="text-sm w-full">
              <tbody>
                <StatRow k="行数 Count" v={fmt(stats.data.Count)} />
                <StatRow k="非重复值 Distinct" v={fmt(stats.data.Distinct)} />
                <StatRow k="NULL 数" v={fmt(stats.data.NullCount)} />
                <StatRow k="最小 / 最大" v={`${fmt(stats.data.Min)} / ${fmt(stats.data.Max)}`} />
                <StatRow k="均值 / 标准差" v={`${num(stats.data.Avg)} / ${num(stats.data.StdDev)}`} />
              </tbody>
            </table>
          ) : (
            <Empty />
          )}
        </Section>

        <Section title="数值分布（20 桶）">
          {distribution.isLoading ? (
            <Loading />
          ) : distData.length ? (
            <ResponsiveContainer width="100%" height={180}>
              <BarChart data={distData}>
                <CartesianGrid strokeDasharray="3 3" className="stroke-muted" />
                <XAxis dataKey="idx" tick={{ fontSize: 11 }} />
                <YAxis tick={{ fontSize: 11 }} />
                <Tooltip />
                <Bar dataKey="count" fill="var(--primary)" />
              </BarChart>
            </ResponsiveContainer>
          ) : (
            <Empty text="该列无可用数值分布。" />
          )}
        </Section>

        <Section title="Top 10 高频值">
          {topn.isLoading ? (
            <Loading />
          ) : topData.length ? (
            <ResponsiveContainer width="100%" height={200}>
              <BarChart data={topData} layout="vertical">
                <CartesianGrid horizontal={false} strokeDasharray="3 3" className="stroke-muted" />
                <XAxis type="number" tick={{ fontSize: 11 }} />
                <YAxis dataKey="name" type="category" width={120} tick={{ fontSize: 11 }} />
                <Tooltip />
                <Bar dataKey="count" fill="var(--primary)" />
              </BarChart>
            </ResponsiveContainer>
          ) : (
            <Empty text="无高频值数据。" />
          )}
        </Section>

        <Section title="正则模式匹配">
          {patterns.isLoading ? (
            <Loading />
          ) : (patterns.data ?? []).length ? (
            <table className="text-sm w-full">
              <thead>
                <tr className="text-left text-muted-foreground">
                  <th>模式</th>
                  <th className="text-right">命中数</th>
                </tr>
              </thead>
              <tbody>
                {(patterns.data ?? []).map((p) => (
                  <tr key={p.Pattern} className="border-t">
                    <td className="font-mono">{p.Pattern}</td>
                    <td className="text-right tabular-nums">{p.Count}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          ) : (
            <Empty text="未匹配到已知模式。" />
          )}
        </Section>
      </SheetContent>
    </Sheet>
  )
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div className="mt-5">
      <h3 className="font-semibold mb-1.5 text-sm">{title}</h3>
      {children}
    </div>
  )
}

function StatRow({ k, v }: { k: string; v: string }) {
  return (
    <tr className="border-b last:border-b-0">
      <td className="py-1 text-muted-foreground">{k}</td>
      <td className="py-1 text-right font-mono tabular-nums">{v}</td>
    </tr>
  )
}

function Loading() {
  return (
    <div className="py-6 text-center text-sm text-muted-foreground">
      <Loader2 className="w-4 h-4 animate-spin inline mr-1" /> 加载中…
    </div>
  )
}

function Empty({ text = "暂无数据。" }: { text?: string }) {
  return <div className="py-4 text-center text-sm text-muted-foreground">{text}</div>
}

function fmt(v: unknown): string {
  if (v === null || v === undefined || v === "") return "-"
  return String(v)
}

function num(v: number | undefined | null): string {
  if (v === null || v === undefined || Number.isNaN(v)) return "-"
  return v.toFixed(2)
}
