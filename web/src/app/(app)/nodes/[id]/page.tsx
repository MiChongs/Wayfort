"use client"

import * as React from "react"
import { use } from "react"
import Link from "next/link"
import { useRouter } from "next/navigation"
import {
  useMutation,
  useQuery,
  useQueryClient,
  type UseMutationResult,
  type UseQueryResult,
} from "@tanstack/react-query"
import {
  Activity,
  ArrowLeft,
  ArrowRight,
  ArrowUpRight,
  Ban,
  CheckCircle2,
  ChevronRight,
  Cloud,
  Copy,
  ExternalLink,
  FolderOpen,
  Heart,
  History,
  Info,
  KeyRound,
  LayoutGrid,
  MinusCircle,
  Monitor,
  MoreHorizontal,
  Network,
  Pencil,
  Play,
  Radio,
  RotateCcw,
  Server,
  ServerCrash,
  Share2,
  ShieldAlert,
  Table as TableIcon,
  Terminal as TerminalIcon,
  Waypoints,
  XCircle,
} from "lucide-react"
import { toast } from "@/components/ui/sonner"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card"
import { Separator } from "@/components/ui/separator"
import { Skeleton } from "@/components/ui/skeleton"
import { Spinner } from "@/components/ui/spinner"
import { ScrollArea } from "@/components/ui/scroll-area"
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs"
import {
  Item,
  ItemActions,
  ItemContent,
  ItemDescription,
  ItemGroup,
  ItemMedia,
  ItemTitle,
} from "@/components/ui/item"
import {
  Breadcrumb,
  BreadcrumbItem,
  BreadcrumbLink,
  BreadcrumbList,
  BreadcrumbPage,
  BreadcrumbSeparator,
} from "@/components/ui/breadcrumb"
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu"
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui/collapsible"
import { HoverCard, HoverCardContent, HoverCardTrigger } from "@/components/ui/hover-card"
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from "@/components/ui/tooltip"
import { CopyButton } from "@/components/common/copy-button"
import { EmptyState } from "@/components/common/empty-state"
import { TagBadge } from "@/components/tags/tag-badge"
import { AppIcon } from "@/components/icons/app-icon"
import { nodeIcon } from "@/lib/icons/protocol"
import { useAccess } from "@/lib/hooks/use-access"
import { fullTime, relTime } from "@/lib/format"
import { cn } from "@/lib/utils"
import { dbService, domainService, meService, nodeService, sessionService } from "@/lib/api/services"
import type {
  DBCapabilities,
  Domain,
  Node,
  NodeProtocol,
  NodeTestResult,
  Session,
  SessionKind,
  SessionStatus,
} from "@/lib/api/types"
import { useWorkspaceStore, type Protocol } from "@/components/workspace/useWorkspaceStore"

// ----- protocol families & db routing (single source of truth) --------------
// DB Studio (structured browse) is only meaningful for the MySQL- and
// Postgres-compatible families. Everything else in the DB world still gets a
// CLI. Driven by family so the Phase-22 domestic engines route correctly
// instead of falling through a hardcoded ["mysql","postgres"] check.
const MYSQL_FAMILY = ["mysql", "tidb", "oceanbase", "starrocks", "doris", "gbase8a"]
const PG_FAMILY = ["postgres", "kingbase", "vastbase", "highgo", "opengauss", "gaussdb"]
const DB_OTHER = ["redis", "mongo", "dameng", "gbase8s"] // CLI only (dameng = Oracle-ish, no studio)
const DB_PROTOCOLS = new Set([...MYSQL_FAMILY, ...PG_FAMILY, ...DB_OTHER])
const DBSTUDIO_OK = new Set([...MYSQL_FAMILY, ...PG_FAMILY])

const PROTO_LABEL: Partial<Record<NodeProtocol, string>> = {
  ssh: "SSH",
  telnet: "Telnet",
  rdp: "RDP",
  vnc: "VNC",
  tcp: "TCP",
  oss: "对象存储",
  mysql: "MySQL",
  postgres: "PostgreSQL",
  redis: "Redis",
  mongo: "MongoDB",
  dameng: "达梦",
  kingbase: "人大金仓",
  vastbase: "Vastbase",
  highgo: "瀚高",
  opengauss: "openGauss",
  gaussdb: "GaussDB",
  tidb: "TiDB",
  oceanbase: "OceanBase",
  starrocks: "StarRocks",
  doris: "Doris",
  gbase8a: "GBase 8a",
  gbase8s: "GBase 8s",
}

function protoLabel(n: Node, caps?: DBCapabilities): string {
  return caps?.vendor_label || PROTO_LABEL[n.protocol] || n.protocol.toUpperCase()
}

// ----- action catalogue -----------------------------------------------------
type Action = {
  key: string
  protocol?: Protocol // when set, opens a workspace tab; absent = plain link
  label: string
  launchLabel: string
  hint: string
  icon: React.ComponentType<{ className?: string }>
  href: string
  external?: boolean
  beta?: boolean
}

const A = {
  ssh: { key: "ssh", protocol: "ssh", label: "SSH 终端", launchLabel: "SSH 连接", hint: "浏览器内终端", icon: TerminalIcon, href: "/ssh" },
  sftp: { key: "sftp", protocol: "sftp", label: "SFTP 文件管理", launchLabel: "打开文件", hint: "上传 / 下载 / 编辑", icon: FolderOpen, href: "/sftp" },
  telnet: { key: "telnet", protocol: "telnet", label: "Telnet 终端", launchLabel: "Telnet 连接", hint: "适合网络设备", icon: TerminalIcon, href: "/telnet" },
  rdp: { key: "rdp", protocol: "rdp", label: "RDP 远程桌面", launchLabel: "打开桌面", hint: "通过 Guacamole 渲染", icon: Monitor, href: "/rdp" },
  rdpNext: { key: "rdpNext", protocol: "rdp_next", label: "RDP（新栈）", launchLabel: "打开桌面", hint: "自研 viewer，低延迟", icon: Monitor, href: "/rdp-next", beta: true },
  vnc: { key: "vnc", protocol: "vnc", label: "VNC 远程桌面", launchLabel: "打开桌面", hint: "通过 Guacamole 渲染", icon: Monitor, href: "/vnc" },
  dbStudio: { key: "dbStudio", protocol: "db_studio", label: "数据库浏览", launchLabel: "打开浏览", hint: "可视化 schema / 表 / SQL", icon: TableIcon, href: "/db" },
  dbcli: { key: "dbcli", protocol: "dbcli", label: "数据库 CLI", launchLabel: "打开 CLI", hint: "一次性容器，结束即销毁", icon: TerminalIcon, href: "/dbcli" },
  oss: { key: "oss", protocol: "oss", label: "对象存储浏览", launchLabel: "打开存储", hint: "浏览桶 / 对象", icon: Cloud, href: "/oss" },
  portForward: { key: "portForward", label: "端口转发", launchLabel: "", hint: "管理网关本地 TCP 转发", icon: Share2, href: "/port-forwards", external: true },
} satisfies Record<string, Action>

function deriveActions(n: Node, caps?: DBCapabilities): Action[] {
  const p = n.protocol
  const out: Action[] = []
  if (p === "ssh") out.push(A.ssh, A.sftp)
  else if (p === "telnet") out.push(A.telnet)
  else if (p === "rdp") out.push(A.rdp, A.rdpNext)
  else if (p === "vnc") out.push(A.vnc)
  else if (p === "tcp") out.push({ ...A.sftp, hint: "如目标支持 SFTP" })
  else if (p === "oss") out.push(A.oss)
  else if (DB_PROTOCOLS.has(p)) {
    if (DBSTUDIO_OK.has(p) && (caps?.list_databases ?? true)) {
      out.push({ ...A.dbStudio, hint: caps?.vendor_label ? `浏览 ${caps.vendor_label} schema / 表` : A.dbStudio.hint })
    }
    out.push({ ...A.dbcli, hint: caps?.vendor_label ? `${caps.vendor_label} 命令行` : A.dbcli.hint })
  }
  out.push(A.portForward)
  const seen = new Set<string>()
  return out.filter((x) => (seen.has(x.key) ? false : (seen.add(x.key), true)))
}

// ----- connectivity (domain reverse-lookup) ---------------------------------
function connLabel(n: Node, domain?: Domain): string {
  if (n.proxy_names?.length) return `代理链 · ${n.proxy_names.length} 跳`
  if (!n.domain_id) return "直连" // no domain assigned = built-in direct
  // domain_id set but not yet resolved (query in-flight / failed): don't claim
  // "直连" — that would mislabel a proxy / reverse-agent domain as direct.
  if (domain) return domain.is_default ? "直连" : { proxy: "代理网域", agent: "反连 Agent", direct: "直连" }[domain.kind]
  return "按网域路由"
}
function connIcon(n: Node, domain?: Domain): React.ComponentType<{ className?: string }> {
  if (n.proxy_names?.length) return Waypoints
  if (!n.domain_id || !domain || domain.is_default) return Network
  return { proxy: Waypoints, agent: Radio, direct: Network }[domain.kind]
}

function connString(n: Node): string {
  const scheme = n.protocol
  const user = n.username ? `${n.username}@` : ""
  return `${scheme}://${user}${n.host}:${n.port}`
}

function prettyJson(s: string): string {
  try {
    return JSON.stringify(JSON.parse(s), null, 2)
  } catch {
    return s
  }
}

// ============================================================================
export default function NodeDetail({ params }: { params: Promise<{ id: string }> }) {
  const { id } = use(params)
  const nodeId = Number(id)
  const qc = useQueryClient()
  const router = useRouter()
  const { isAdmin } = useAccess()
  const open = useWorkspaceStore((s) => s.open)

  const node = useQuery({ queryKey: ["node", nodeId], queryFn: () => nodeService.get(nodeId) })
  const fav = useQuery({ queryKey: ["me", "favorites"], queryFn: meService.favorites })
  const recent = useQuery({ queryKey: ["me", "recent-nodes"], queryFn: () => meService.recentNodes(50) })

  const sessions = useQuery({
    queryKey: ["sessions", "node", nodeId],
    queryFn: () => sessionService.list({ node_id: nodeId, limit: 10 }),
    enabled: !!node.data,
  })
  const domains = useQuery({
    queryKey: ["domains"],
    queryFn: domainService.list,
    enabled: !!node.data?.domain_id,
    staleTime: 300_000,
  })
  const isDb = node.data ? DB_PROTOCOLS.has(node.data.protocol) : false
  const caps = useQuery({
    queryKey: ["db", "caps", nodeId],
    queryFn: () => dbService.capabilities(nodeId),
    enabled: isDb,
    retry: false,
  })
  const test = useMutation({ mutationFn: () => nodeService.test(nodeId) })

  const toggleFav = useMutation({
    mutationFn: ({ current }: { current: boolean }) =>
      current ? meService.removeFavorite(nodeId) : meService.addFavorite(nodeId),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["me", "favorites"] }),
    onError: (e: unknown) => toast.error("操作失败", { description: (e as Error).message }),
  })

  if (node.isLoading) return <LoadingSkeleton />
  if (node.isError || !node.data) {
    return (
      <NotFoundState
        isError={node.isError}
        message={(node.error as Error)?.message}
        onRetry={() => node.refetch()}
      />
    )
  }

  const n = node.data
  const isFav = (fav.data?.node_ids ?? []).includes(nodeId)
  const myUse = recent.data?.recent.find((r) => r.node_id === nodeId)
  const sess = sessions.data?.sessions ?? []
  const totalSessions = sessions.data?.total ?? 0
  const domain = domains.data?.domains.find((d) => d.id === n.domain_id)
  const managedTags = n.tag_list ?? []
  const freeTags = (n.tags ?? "").split(",").map((t) => t.trim()).filter(Boolean)
  const actions = deriveActions(n, caps.data)
  const primary = actions.find((a) => a.protocol)

  const launch = (a: Action) => {
    if (!a.protocol) return
    open({ nodeId, protocol: a.protocol, title: n.name, host: n.host, port: n.port })
    router.push("/workspace" as Parameters<typeof router.push>[0])
  }

  const ConnIcon = connIcon(n, domain)

  return (
    <TooltipProvider delayDuration={200}>
      <div className="p-4 sm:p-6 space-y-6">
        <Breadcrumb>
          <BreadcrumbList>
            <BreadcrumbItem>
              <BreadcrumbLink asChild>
                <Link href={(isAdmin ? "/admin/nodes" : "/nodes") as Parameters<typeof Link>[0]["href"]}>资产</Link>
              </BreadcrumbLink>
            </BreadcrumbItem>
            <BreadcrumbSeparator />
            <BreadcrumbItem>
              <BreadcrumbPage className="max-w-[16rem] truncate" title={n.name}>
                {n.name}
              </BreadcrumbPage>
            </BreadcrumbItem>
          </BreadcrumbList>
        </Breadcrumb>

        <div className="grid grid-cols-1 gap-6 lg:grid-cols-[300px_minmax(0,1fr)] lg:items-start">
          {/* ---- left rail: identity + connectivity test (sticky) ---- */}
          <aside className="min-w-0 space-y-6 lg:sticky lg:top-6">
            <IdentityHeroCard
              n={n}
              caps={caps.data}
              isFav={isFav}
              favPending={toggleFav.isPending}
              onToggleFav={() => toggleFav.mutate({ current: isFav })}
              isAdmin={isAdmin}
              managedTags={managedTags}
              freeTags={freeTags}
              myUse={myUse}
              totalSessions={totalSessions}
              latestSession={sess[0]}
              connLabelText={connLabel(n, domain)}
              connSub={domain && !domain.is_default ? domain.name : undefined}
              ConnIcon={ConnIcon}
              primary={primary}
              onLaunch={launch}
            />
            <ConnectivityTestCard test={test} />
          </aside>

          {/* ---- right rail: tabbed main area ---- */}
          <div className="@container min-w-0 space-y-6">
            <Tabs defaultValue="connect">
              <TabsList className="w-full justify-start sm:w-auto">
                <TabsTrigger value="connect">连接</TabsTrigger>
                <TabsTrigger value="sessions" className="gap-1.5">
                  会话
                  {totalSessions > 0 && (
                    <Badge variant="soft" className="rounded-full px-1.5 text-[10px] tabular-nums">
                      {totalSessions}
                    </Badge>
                  )}
                </TabsTrigger>
                <TabsTrigger value="advanced">详情</TabsTrigger>
              </TabsList>

              <TabsContent value="connect" className="mt-4">
                <ActionGrid n={n} nodeId={nodeId} actions={actions} primary={primary} onLaunch={launch} />
              </TabsContent>

              <TabsContent value="sessions" className="mt-4">
                <RecentSessionsCard nodeId={nodeId} query={sessions} sessions={sess} />
              </TabsContent>

              <TabsContent value="advanced" className="mt-4">
                <AdvancedCard n={n} domain={domain} ConnIcon={ConnIcon} connText={connLabel(n, domain)} caps={caps.data} isAdmin={isAdmin} />
              </TabsContent>
            </Tabs>
          </div>
        </div>
      </div>
    </TooltipProvider>
  )
}

// ----- identity hero --------------------------------------------------------
function IdentityHeroCard({
  n,
  caps,
  isFav,
  favPending,
  onToggleFav,
  isAdmin,
  managedTags,
  freeTags,
  myUse,
  totalSessions,
  latestSession,
  connLabelText,
  connSub,
  ConnIcon,
  primary,
  onLaunch,
}: {
  n: Node
  caps?: DBCapabilities
  isFav: boolean
  favPending: boolean
  onToggleFav: () => void
  isAdmin: boolean
  managedTags: NonNullable<Node["tag_list"]>
  freeTags: string[]
  myUse?: { last_used_at: string; hits: number }
  totalSessions: number
  latestSession?: Session
  connLabelText: string
  connSub?: string
  ConnIcon: React.ComponentType<{ className?: string }>
  primary?: Action
  onLaunch: (a: Action) => void
}) {
  return (
    <Card className="@container gap-0 overflow-hidden p-0">
      <div className="bg-gradient-to-br from-primary/[0.07] via-card to-card px-6 py-6">
        <div className="flex min-w-0 items-start gap-3">
          <div className="flex size-11 shrink-0 items-center justify-center rounded-xl border border-border bg-background">
            <AppIcon icon={nodeIcon(n)} size={22} />
          </div>
          <div className="min-w-0 flex-1">
            <h1 className="truncate text-2xl font-semibold tracking-tight text-foreground" title={n.name}>
              {n.name}
            </h1>
            <div className="mt-1.5 flex flex-wrap items-center gap-1.5">
              <Badge variant="secondary" className="shrink-0 whitespace-nowrap font-normal">
                {protoLabel(n, caps)}
              </Badge>
              <StatusBadge n={n} />
              {n.region && (
                <Badge variant="outline" className="shrink-0">
                  {n.region}
                </Badge>
              )}
            </div>
          </div>
        </div>

        <div className="mt-4 flex min-w-0 items-center gap-1.5">
          <code className="min-w-0 truncate font-mono text-sm text-muted-foreground" title={`${n.host}:${n.port}`}>
            {n.host}:{n.port}
          </code>
          <CopyButton value={`${n.host}:${n.port}`} className="size-6 shrink-0" />
        </div>

        {(managedTags.length > 0 || freeTags.length > 0) && (
          <div className="mt-3 flex flex-wrap gap-1.5">
            {managedTags.length > 0
              ? managedTags.map((t) => <TagBadge key={t.id} tag={t} size="sm" showDot />)
              : freeTags.map((t) => (
                  <Badge key={t} variant="outline" className="shrink-0 rounded-full">
                    #{t}
                  </Badge>
                ))}
          </div>
        )}

        {n.description && (
          <p className="mt-3 line-clamp-2 break-words text-sm text-muted-foreground" title={n.description}>
            {n.description}
          </p>
        )}

        {/* primary action row — the one and only coral button on the page */}
        <div className="mt-4 flex items-center gap-2">
          {!n.disabled && primary ? (
            <Button size="sm" className="flex-1" onClick={() => onLaunch(primary)}>
              <Play className="size-4" /> {primary.launchLabel}
            </Button>
          ) : n.disabled ? (
            <Button size="sm" variant="outline" className="flex-1" disabled>
              <Ban className="size-4" /> 已禁用
            </Button>
          ) : (
            <Button size="sm" variant="outline" className="flex-1" asChild>
              <Link href={"/workspace" as Parameters<typeof Link>[0]["href"]}>
                <LayoutGrid className="size-4" /> 工作台
              </Link>
            </Button>
          )}

          <Button
            size="sm"
            variant={isFav ? "secondary" : "outline"}
            onClick={onToggleFav}
            disabled={favPending}
            aria-pressed={isFav}
            aria-label={isFav ? "取消收藏" : "收藏"}
          >
            {favPending ? (
              <Spinner className="size-4" />
            ) : (
              <Heart className={cn("size-4", isFav && "fill-current text-primary")} />
            )}
          </Button>

          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button size="sm" variant="outline" aria-label="更多操作">
                <MoreHorizontal className="size-4" />
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end">
              <DropdownMenuItem
                onClick={async () => {
                  try {
                    await navigator.clipboard.writeText(connString(n))
                    toast.success("已复制连接信息")
                  } catch {
                    toast.error("复制失败")
                  }
                }}
              >
                <Copy className="size-4" /> 复制连接信息
              </DropdownMenuItem>
              <DropdownMenuItem asChild>
                <Link href={"/port-forwards" as Parameters<typeof Link>[0]["href"]}>
                  <Share2 className="size-4" /> 端口转发
                </Link>
              </DropdownMenuItem>
              <DropdownMenuItem asChild>
                <Link href={"/workspace" as Parameters<typeof Link>[0]["href"]}>
                  <LayoutGrid className="size-4" /> 切换到工作台
                </Link>
              </DropdownMenuItem>
              {isAdmin && (
                <>
                  <DropdownMenuSeparator />
                  <DropdownMenuItem asChild>
                    <Link href={"/admin/nodes" as Parameters<typeof Link>[0]["href"]}>
                      <Pencil className="size-4" /> 在资产控制台编辑
                    </Link>
                  </DropdownMenuItem>
                </>
              )}
            </DropdownMenuContent>
          </DropdownMenu>
        </div>
      </div>

      {/* stat strip */}
      <div className="grid grid-cols-1 divide-y border-t @xl:grid-cols-3 @xl:divide-x @xl:divide-y-0">
        <Stat
          icon={History}
          label="我的上次使用"
          value={myUse ? relTime(myUse.last_used_at) || "—" : "从未使用"}
          sub={myUse ? `累计 ${myUse.hits} 次` : undefined}
          hint={myUse ? fullTime(myUse.last_used_at) : undefined}
        />
        <Stat
          icon={Activity}
          label="会话总数"
          value={String(totalSessions)}
          valueClassName="tabular-nums"
          sub={latestSession ? `最近 ${relTime(latestSession.started_at) || "—"}` : "暂无会话"}
        />
        <Stat icon={ConnIcon} label="连通方式" value={connLabelText} sub={connSub} />
      </div>
    </Card>
  )
}

function Stat({
  icon: Icon,
  label,
  value,
  sub,
  hint,
  valueClassName,
}: {
  icon: React.ComponentType<{ className?: string }>
  label: string
  value: string
  sub?: string
  hint?: string
  valueClassName?: string
}) {
  return (
    <div className="flex items-start gap-3 px-5 py-4">
      <div className="mt-0.5 flex size-9 shrink-0 items-center justify-center rounded-full bg-muted text-muted-foreground">
        <Icon className="size-4" />
      </div>
      <div className="min-w-0 flex-1">
        <p className="text-xs text-muted-foreground">{label}</p>
        <p className={cn("truncate text-sm font-medium", valueClassName)} title={hint}>
          {value}
        </p>
        {sub && <p className="truncate text-xs text-muted-foreground/80">{sub}</p>}
      </div>
    </div>
  )
}

function StatusBadge({ n }: { n: Node }) {
  if (n.disabled)
    return (
      <Badge variant="destructive" className="shrink-0 gap-1">
        <Ban className="size-3" /> 已禁用
      </Badge>
    )
  if (n.requires_approval_for_connect)
    return (
      <Badge variant="warning" className="shrink-0 gap-1">
        <ShieldAlert className="size-3" /> 连接需审批
      </Badge>
    )
  return (
    <Badge variant="success" className="shrink-0 gap-1">
      <CheckCircle2 className="size-3" /> 可用
    </Badge>
  )
}

// ----- connectivity test ----------------------------------------------------
function ConnectivityTestCard({ test }: { test: UseMutationResult<NodeTestResult, Error, void> }) {
  const data = test.data
  return (
    <Card className="border-dashed bg-secondary/30">
      <CardContent className="space-y-3 p-4">
        <div className="flex items-center justify-between gap-2">
          <span className="text-sm font-medium">连通性</span>
          <Tooltip>
            <TooltipTrigger asChild>
              <button type="button" aria-label="说明" className="text-muted-foreground hover:text-foreground">
                <Info className="size-3.5" />
              </button>
            </TooltipTrigger>
            <TooltipContent className="max-w-[15rem]">
              从网关<span className="font-medium text-foreground">直连</span>探测目标可达性，不经过代理链 / 网域，仅供参考。
            </TooltipContent>
          </Tooltip>
        </div>

        <Button size="sm" variant="outline" className="w-full" disabled={test.isPending} onClick={() => test.mutate()}>
          {test.isPending ? <Spinner className="size-4" /> : <Radio className="size-4" />}
          {test.isPending ? "探测中…" : data ? "重新探测" : "测试连通性"}
        </Button>

        {data && (
          <div
            className={cn(
              "flex items-start gap-2 rounded-lg border p-2.5 text-sm",
              data.ok ? "border-success/30 bg-success/10" : "border-destructive/30 bg-destructive/10",
            )}
          >
            {data.ok ? (
              <CheckCircle2 className="mt-0.5 size-4 shrink-0 text-success" />
            ) : (
              <XCircle className="mt-0.5 size-4 shrink-0 text-destructive" />
            )}
            <div className="min-w-0">
              {data.ok ? (
                <p className="flex flex-wrap items-center gap-x-2 text-success">
                  <span>
                    可达 · <span className="font-medium tabular-nums">{data.latency_ms ?? "?"} ms</span>
                  </span>
                  {data.mode && (
                    <Badge variant="outline" className="shrink-0 uppercase">
                      {data.mode}
                    </Badge>
                  )}
                </p>
              ) : (
                <p className="truncate text-destructive" title={data.error}>
                  {data.error || "不可达"}
                </p>
              )}
              {data.target && (
                <p className="mt-0.5 truncate font-mono text-xs text-muted-foreground" title={data.target}>
                  目标 {data.target}
                </p>
              )}
            </div>
          </div>
        )}

        {test.isError && <p className="text-sm text-destructive">请求失败：{(test.error as Error)?.message}</p>}
      </CardContent>
    </Card>
  )
}

// ----- connect tab ----------------------------------------------------------
function ActionGrid({
  n,
  nodeId,
  actions,
  primary,
  onLaunch,
}: {
  n: Node
  nodeId: number
  actions: Action[]
  primary?: Action
  onLaunch: (a: Action) => void
}) {
  return (
    <Card>
      <CardHeader className="flex-row items-center justify-between gap-4">
        <div className="min-w-0">
          <CardTitle className="text-base font-medium">连接方式</CardTitle>
          <CardDescription>首选在工作台打开（多标签保活）；也可用独立页面。</CardDescription>
        </div>
        {!n.disabled && (
          <Button variant="ghost" size="sm" asChild className="shrink-0">
            <Link href={"/workspace" as Parameters<typeof Link>[0]["href"]}>
              <LayoutGrid className="size-3.5" /> 工作台
            </Link>
          </Button>
        )}
      </CardHeader>
      <CardContent className="pb-4">
        {n.disabled ? (
          <div className="rounded-lg border border-destructive/30 bg-destructive/10 p-3 text-sm text-destructive">
            该节点已被管理员禁用，暂时无法连接。
          </div>
        ) : (
          <ItemGroup className="grid grid-cols-1 gap-3 @xl:grid-cols-2">
            {actions.map((a) => (
              <ActionItem
                key={a.key}
                action={a}
                nodeId={nodeId}
                requiresApproval={!!n.requires_approval_for_connect}
                isPrimary={a === primary}
                onLaunch={onLaunch}
              />
            ))}
          </ItemGroup>
        )}
      </CardContent>
    </Card>
  )
}

function ActionItem({
  action,
  nodeId,
  requiresApproval,
  isPrimary,
  onLaunch,
}: {
  action: Action
  nodeId: number
  requiresApproval: boolean
  isPrimary: boolean
  onLaunch: (a: Action) => void
}) {
  return (
    <Item variant="outline" className={cn("min-w-0 rounded-xl", isPrimary && "border-border bg-muted/40")}>
      <ItemMedia variant="icon">
        <action.icon className="size-5" />
      </ItemMedia>
      <ItemContent className="min-w-0">
        <ItemTitle className="flex min-w-0 items-center gap-1.5">
          <span className="truncate">{action.label}</span>
          {isPrimary && (
            <Badge variant="secondary" className="shrink-0 rounded-full font-normal">
              首选
            </Badge>
          )}
          {action.beta && (
            <Badge variant="soft" className="shrink-0 rounded-full">
              Beta
            </Badge>
          )}
          {requiresApproval && action.protocol && (
            <Badge variant="warning" className="shrink-0 gap-1 rounded-full">
              <ShieldAlert className="size-3" /> 需审批
            </Badge>
          )}
        </ItemTitle>
        <ItemDescription className="truncate" title={action.hint}>
          {action.hint}
        </ItemDescription>
      </ItemContent>
      <ItemActions className="shrink-0 gap-1">
        {action.external ? (
          <Button size="sm" variant="outline" asChild>
            <Link href={action.href as Parameters<typeof Link>[0]["href"]}>
              打开 <ArrowUpRight className="size-3.5" />
            </Link>
          </Button>
        ) : (
          <>
            <Button size="sm" variant="secondary" onClick={() => onLaunch(action)}>
              工作台
            </Button>
            <Tooltip>
              <TooltipTrigger asChild>
                <Button size="sm" variant="ghost" className="px-2" asChild aria-label="在独立页面打开">
                  <Link href={`/nodes/${nodeId}${action.href}` as Parameters<typeof Link>[0]["href"]}>
                    <ExternalLink className="size-3.5" />
                  </Link>
                </Button>
              </TooltipTrigger>
              <TooltipContent>在独立页面打开</TooltipContent>
            </Tooltip>
          </>
        )}
      </ItemActions>
    </Item>
  )
}

// ----- sessions tab ---------------------------------------------------------
const SESSION_STATUS: Record<SessionStatus, { label: string; variant: React.ComponentProps<typeof Badge>["variant"] }> = {
  active: { label: "进行中", variant: "success" },
  closed: { label: "已结束", variant: "secondary" },
  terminated: { label: "已终止", variant: "warning" },
  errored: { label: "异常", variant: "destructive" },
}
const SESSION_KIND: Record<SessionKind, { label: string; icon: React.ComponentType<{ className?: string }> }> = {
  interactive: { label: "交互终端", icon: TerminalIcon },
  anonymous: { label: "匿名会话", icon: TerminalIcon },
  sftp: { label: "文件传输", icon: FolderOpen },
  graphical: { label: "图形桌面", icon: Monitor },
  tcp_forward: { label: "端口转发", icon: Share2 },
  oss: { label: "对象存储", icon: Cloud },
}

function RecentSessionsCard({
  nodeId,
  query,
  sessions,
}: {
  nodeId: number
  query: UseQueryResult<{ sessions: Session[]; total: number }, Error>
  sessions: Session[]
}) {
  return (
    <Card className="gap-0 p-0">
      <CardHeader className="flex-row items-center justify-between gap-4 p-6 pb-3">
        <div className="min-w-0">
          <CardTitle className="text-base font-medium">最近会话</CardTitle>
          <CardDescription>此节点上最近的连接记录</CardDescription>
        </div>
        <Button variant="ghost" size="sm" asChild className="shrink-0">
          <Link href={`/sessions?node_id=${nodeId}` as Parameters<typeof Link>[0]["href"]}>
            查看全部 <ArrowRight className="size-3.5" />
          </Link>
        </Button>
      </CardHeader>
      <CardContent className="p-0 pb-2">
        {query.isLoading ? (
          <div className="space-y-1 px-4 pb-2">
            {Array.from({ length: 4 }).map((_, i) => (
              <div key={i} className="flex items-center gap-3 px-2 py-2.5">
                <Skeleton className="size-8 shrink-0 rounded-md" />
                <div className="flex-1 space-y-2">
                  <Skeleton className="h-3.5 w-32" />
                  <Skeleton className="h-3 w-48" />
                </div>
              </div>
            ))}
          </div>
        ) : query.isError ? (
          <div className="px-6 py-8 text-center text-sm text-muted-foreground">
            会话记录暂不可用 ·{" "}
            <Button variant="link" className="h-auto p-0" onClick={() => query.refetch()}>
              重试
            </Button>
          </div>
        ) : sessions.length === 0 ? (
          <EmptyState
            icon={History}
            title="还没有连接过这个节点"
            description="从「连接」里选择一种方式即可开始。"
            className="py-10"
          />
        ) : (
          <ItemGroup>
            {sessions.map((s) => {
              const kind = SESSION_KIND[s.kind] ?? { label: s.kind, icon: TerminalIcon }
              const KindIcon = kind.icon
              return (
                <Item key={s.id} asChild>
                  <Link href={`/sessions/${s.id}` as Parameters<typeof Link>[0]["href"]}>
                    <ItemMedia variant="icon">
                      <KindIcon className="size-4" />
                    </ItemMedia>
                    <ItemContent className="min-w-0">
                      <ItemTitle className="flex min-w-0 items-center gap-2">
                        <span className="truncate">{s.username}</span>
                        <SessionStatusBadge status={s.status} />
                      </ItemTitle>
                      <ItemDescription className="flex flex-wrap items-center gap-x-2 truncate" title={fullTime(s.started_at)}>
                        <span>
                          {kind.label} · {relTime(s.started_at) || "—"}
                        </span>
                        {typeof s.avg_rtt_ms === "number" && s.avg_rtt_ms > 0 && (
                          <span className="tabular-nums">· RTT {Math.round(s.avg_rtt_ms)}ms</span>
                        )}
                        {!!s.reconnect_count && <span>· 重连 {s.reconnect_count} 次</span>}
                      </ItemDescription>
                    </ItemContent>
                    {s.recording_path && (
                      <ItemActions className="shrink-0">
                        <span className="inline-flex items-center gap-1 text-xs text-muted-foreground">
                          <Play className="size-3.5" /> 回放
                        </span>
                      </ItemActions>
                    )}
                  </Link>
                </Item>
              )
            })}
          </ItemGroup>
        )}
      </CardContent>
    </Card>
  )
}

function SessionStatusBadge({ status }: { status: SessionStatus }) {
  const m = SESSION_STATUS[status] ?? { label: status, variant: "outline" as const }
  return (
    <Badge variant={m.variant} className="shrink-0">
      {m.label}
    </Badge>
  )
}

// ----- advanced tab ---------------------------------------------------------
function AdvancedCard({
  n,
  domain,
  ConnIcon,
  connText,
  caps,
  isAdmin,
}: {
  n: Node
  domain?: Domain
  ConnIcon: React.ComponentType<{ className?: string }>
  connText: string
  caps?: DBCapabilities
  isAdmin: boolean
}) {
  return (
    <Card>
      <CardContent className="space-y-6 p-6">
        {/* connection config */}
        <section className="space-y-3">
          <h3 className="text-sm font-medium text-foreground">连接配置</h3>
          <dl className="space-y-2.5">
            <InfoRow label="用户名">
              {n.username ? (
                <code className="truncate font-mono text-sm" title={n.username}>
                  {n.username}
                </code>
              ) : (
                <span className="text-muted-foreground">—</span>
              )}
            </InfoRow>
            <InfoRow label="凭据">
              <CredentialCell n={n} isAdmin={isAdmin} />
            </InfoRow>
            <InfoRow label="连通方式">
              <ConnectivityCell n={n} domain={domain} ConnIcon={ConnIcon} connText={connText} />
            </InfoRow>
          </dl>
        </section>

        <Separator />

        {/* access control */}
        <section className="space-y-3">
          <h3 className="text-sm font-medium text-foreground">访问控制</h3>
          {n.requires_approval_for_connect || n.requires_approval_for_file_xfer ? (
            <div className="flex flex-wrap gap-1.5">
              {n.requires_approval_for_connect && (
                <Badge variant="warning" className="gap-1 font-normal">
                  <ShieldAlert className="size-3" /> 连接需审批
                </Badge>
              )}
              {n.requires_approval_for_file_xfer && (
                <Badge variant="warning" className="gap-1 font-normal">
                  <ShieldAlert className="size-3" /> 文件传输需审批
                </Badge>
              )}
            </div>
          ) : (
            <p className="text-sm text-muted-foreground">无需审批，可直接连接。</p>
          )}
        </section>

        {/* protocol options */}
        {(n.proto_options || (caps && Object.keys(caps).length > 0)) && (
          <>
            <Separator />
            <section className="space-y-3">
              <h3 className="text-sm font-medium text-foreground">协议参数</h3>
              {n.protocol === "rdp" && n.proto_options && <RdpOptionsView raw={n.proto_options} />}
              {caps && <DbCapabilityMatrix caps={caps} />}
              {n.proto_options && (
                <Collapsible>
                  <CollapsibleTrigger className="group flex items-center gap-1 text-xs text-muted-foreground hover:text-foreground">
                    <ChevronRight className="size-3.5 transition-transform group-data-[state=open]:rotate-90" />
                    查看原始参数
                  </CollapsibleTrigger>
                  <CollapsibleContent>
                    <div className="relative mt-2">
                      <CopyButton value={prettyJson(n.proto_options)} className="absolute right-2 top-2 z-10 size-6" />
                      <ScrollArea className="max-h-72 rounded-md bg-muted">
                        <pre className="whitespace-pre-wrap break-all p-3 font-mono text-xs">{prettyJson(n.proto_options)}</pre>
                      </ScrollArea>
                    </div>
                  </CollapsibleContent>
                </Collapsible>
              )}
            </section>
          </>
        )}

        <Separator />

        {/* meta */}
        <section className="space-y-3">
          <h3 className="text-sm font-medium text-foreground">元信息</h3>
          <dl className="space-y-2.5">
            <InfoRow label="节点 ID">
              <span className="flex items-center gap-1">
                <code className="font-mono text-sm">#{n.id}</code>
                <CopyButton value={String(n.id)} className="size-5 shrink-0" />
              </span>
            </InfoRow>
            {isAdmin && n.credential_id > 0 && (
              <InfoRow label="凭据 ID">
                <code className="font-mono text-sm">#{n.credential_id}</code>
              </InfoRow>
            )}
            {n.created_at && (
              <InfoRow label="创建于">
                <span className="text-sm" title={fullTime(n.created_at)}>
                  {relTime(n.created_at) || "—"}
                </span>
              </InfoRow>
            )}
            {n.updated_at && (
              <InfoRow label="更新于">
                <span className="text-sm" title={fullTime(n.updated_at)}>
                  {relTime(n.updated_at) || "—"}
                </span>
              </InfoRow>
            )}
          </dl>
        </section>
      </CardContent>
    </Card>
  )
}

function InfoRow({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="flex items-center justify-between gap-3">
      <dt className="shrink-0 text-sm text-muted-foreground">{label}</dt>
      <dd className="flex min-w-0 items-center justify-end text-right">{children}</dd>
    </div>
  )
}

function CredentialCell({ n, isAdmin }: { n: Node; isAdmin: boolean }) {
  if (!n.credential_name) {
    return <span className="text-muted-foreground">{n.credential_id ? `#${n.credential_id}` : "—"}</span>
  }
  return (
    <HoverCard openDelay={150}>
      <HoverCardTrigger asChild>
        <span className="inline-flex min-w-0 cursor-default items-center gap-1.5 truncate" title={n.credential_name}>
          <KeyRound className="size-3.5 shrink-0 text-muted-foreground" />
          <span className="truncate">{n.credential_name}</span>
        </span>
      </HoverCardTrigger>
      <HoverCardContent className="w-72 text-sm">
        <p className="flex items-center gap-1.5 font-medium">
          <KeyRound className="size-3.5" />
          {n.credential_name}
        </p>
        <p className="mt-1 text-xs text-muted-foreground">
          凭据 #{n.credential_id} · 登录用户 {n.username || "—"}
        </p>
        {isAdmin && (
          <Button variant="link" size="sm" className="mt-1 h-auto px-0" asChild>
            <Link href={"/admin/credentials" as Parameters<typeof Link>[0]["href"]}>
              管理凭据 <ArrowRight className="size-3" />
            </Link>
          </Button>
        )}
      </HoverCardContent>
    </HoverCard>
  )
}

function ConnectivityCell({
  n,
  domain,
  ConnIcon,
  connText,
}: {
  n: Node
  domain?: Domain
  ConnIcon: React.ComponentType<{ className?: string }>
  connText: string
}) {
  return (
    <span className="flex min-w-0 items-center gap-1.5">
      <ConnIcon className="size-3.5 shrink-0 text-muted-foreground" />
      <span className="truncate text-sm">{connText}</span>
      {domain && !domain.is_default && (
        <Badge variant="outline" className="max-w-[10rem] shrink-0 truncate" title={domain.name}>
          {domain.name}
        </Badge>
      )}
      {!!n.proxy_names?.length && (
        <HoverCard>
          <HoverCardTrigger asChild>
            <Badge
              variant="soft"
              className="shrink-0 cursor-default rounded-full"
              title={n.proxy_names.join(" → ")}
            >
              {n.proxy_names.length} 跳
            </Badge>
          </HoverCardTrigger>
          <HoverCardContent className="font-mono text-sm break-all">{n.proxy_names.join(" → ")}</HoverCardContent>
        </HoverCard>
      )}
    </span>
  )
}

// RDP proto_options humanised. Parse-tolerant: a bad JSON string just renders
// nothing here (the raw collapsible below still shows it).
const RDP_SECURITY: Record<string, string> = {
  any: "自动协商",
  nla: "NLA（CredSSP）",
  tls: "TLS",
  rdp: "旧版加密",
}
const RDP_GFX: Record<string, string> = {
  auto: "自动",
  avc444: "H.264 AVC444",
  avc420: "H.264 AVC420",
  rfx: "RemoteFX",
  nsc: "NSCodec",
  none: "关闭",
}
const RDP_NET: Record<string, string> = {
  lan: "LAN",
  broadband: "宽带",
  wan: "WAN",
  mobile: "移动",
  auto: "自动",
}

function RdpOptionsView({ raw }: { raw: string }) {
  let rdp: Record<string, unknown> | null = null
  try {
    const o = JSON.parse(raw) as Record<string, unknown>
    rdp = (o.rdp as Record<string, unknown>) ?? o
  } catch {
    return null
  }
  if (!rdp || typeof rdp !== "object") return null

  const rows: { label: string; value: React.ReactNode; title?: string }[] = []
  const s = (k: string) => (typeof rdp![k] === "string" ? (rdp![k] as string) : undefined)
  const num = (k: string) => (typeof rdp![k] === "number" ? (rdp![k] as number) : undefined)
  const bool = (k: string) => rdp![k] === true

  if (s("security")) rows.push({ label: "安全层", value: RDP_SECURITY[s("security")!] ?? s("security") })
  if (num("color_depth")) rows.push({ label: "色深", value: `${num("color_depth")} 位` })
  if (rdp.high_dpi !== undefined)
    rows.push({
      label: "高 DPI",
      value: bool("high_dpi") ? (num("max_scale") ? `开启 · 上限 ${num("max_scale")}%` : "开启") : "关闭",
    })
  if (rdp.dynamic_resolution !== undefined)
    rows.push({ label: "动态分辨率", value: bool("dynamic_resolution") ? "跟随窗口" : "固定" })
  if (bool("console_session")) rows.push({ label: "控制台会话", value: "是" })
  if (s("gfx_codec")) rows.push({ label: "图形编解码", value: RDP_GFX[s("gfx_codec")!] ?? s("gfx_codec") })
  if (s("network_preset")) rows.push({ label: "网络档", value: RDP_NET[s("network_preset")!] ?? s("network_preset") })
  if (s("keyboard")) rows.push({ label: "键盘布局", value: <code className="font-mono text-xs">{s("keyboard")}</code>, title: s("keyboard") })
  if (s("domain")) rows.push({ label: "域", value: <code className="font-mono text-xs">{s("domain")}</code>, title: s("domain") })
  if (s("gateway_host")) {
    const gw = `${s("gateway_host")}${num("gateway_port") ? `:${num("gateway_port")}` : ""}`
    rows.push({ label: "RD 网关", value: <code className="font-mono text-xs">{gw}</code>, title: gw })
  }

  if (rows.length === 0 && !bool("ignore_cert")) return null

  return (
    <dl className="space-y-2.5">
      {rows.map((r) => (
        <InfoRow key={r.label} label={r.label}>
          <span className="truncate text-sm" title={r.title}>
            {r.value}
          </span>
        </InfoRow>
      ))}
      {bool("ignore_cert") && (
        <InfoRow label="证书校验">
          <Badge variant="warning" className="gap-1 font-normal">
            <ShieldAlert className="size-3" /> 忽略证书
          </Badge>
        </InfoRow>
      )}
    </dl>
  )
}

const DB_CAP_FIELDS: { key: keyof DBCapabilities; label: string }[] = [
  { key: "list_databases", label: "库列表" },
  { key: "schemas", label: "Schema" },
  { key: "row_edits", label: "行编辑" },
  { key: "explain", label: "执行计划" },
  { key: "processes", label: "进程" },
  { key: "kill_process", label: "终止进程" },
  { key: "table_ddl", label: "建表语句" },
  { key: "table_stats", label: "表统计" },
  { key: "foreign_keys", label: "外键" },
  { key: "sequences", label: "序列" },
  { key: "functions", label: "函数" },
  { key: "transactions", label: "事务" },
]

function DbCapabilityMatrix({ caps }: { caps: DBCapabilities }) {
  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center gap-2">
        {caps.vendor_label && (
          <Badge variant="secondary" className="font-normal">
            {caps.vendor_label}
          </Badge>
        )}
        <span className="text-xs text-muted-foreground">
          {caps.database_scope === "catalog" ? "多库（catalog）" : "单库多 schema"}
        </span>
      </div>
      <div className="grid grid-cols-2 gap-2 @sm:grid-cols-3">
        {DB_CAP_FIELDS.map((f) => {
          const on = !!caps[f.key]
          return (
            <span
              key={f.key}
              className={cn("flex items-center gap-1.5 text-xs", on ? "text-foreground" : "text-muted-foreground/60")}
            >
              {on ? (
                <CheckCircle2 className="size-3.5 shrink-0 text-success" />
              ) : (
                <MinusCircle className="size-3.5 shrink-0 text-muted-foreground/40" />
              )}
              {f.label}
            </span>
          )
        })}
      </div>
    </div>
  )
}

// ----- loading / not-found --------------------------------------------------
function LoadingSkeleton() {
  return (
    <div className="space-y-6 p-4 sm:p-6">
      <Skeleton className="h-4 w-40" />
      <div className="grid grid-cols-1 gap-6 lg:grid-cols-[300px_minmax(0,1fr)] lg:items-start">
        <div className="space-y-6">
          <Card className="@container gap-0 overflow-hidden p-0">
            <div className="space-y-4 bg-gradient-to-br from-primary/[0.07] via-card to-card px-6 py-6">
              <div className="flex gap-3">
                <Skeleton className="size-11 rounded-xl" />
                <div className="flex-1 space-y-2">
                  <Skeleton className="h-7 w-3/4" />
                  <Skeleton className="h-5 w-1/2" />
                </div>
              </div>
              <Skeleton className="h-9 w-full rounded-md" />
            </div>
            <div className="grid grid-cols-1 divide-y border-t @xl:grid-cols-3 @xl:divide-x @xl:divide-y-0">
              {Array.from({ length: 3 }).map((_, i) => (
                <div key={i} className="flex items-start gap-3 px-5 py-4">
                  <Skeleton className="size-9 rounded-full" />
                  <div className="space-y-2">
                    <Skeleton className="h-3 w-14" />
                    <Skeleton className="h-4 w-20" />
                  </div>
                </div>
              ))}
            </div>
          </Card>
          <Card className="space-y-3 p-4">
            <Skeleton className="h-4 w-20" />
            <Skeleton className="h-9 w-full rounded-md" />
          </Card>
        </div>
        <div className="space-y-4">
          <Skeleton className="h-9 w-64 rounded-md" />
          <div className="grid gap-3">
            {Array.from({ length: 4 }).map((_, i) => (
              <Skeleton key={i} className="h-20 rounded-xl" />
            ))}
          </div>
        </div>
      </div>
    </div>
  )
}

function NotFoundState({ isError, message, onRetry }: { isError: boolean; message?: string; onRetry: () => void }) {
  return (
    <div className="p-4 sm:p-6">
      <Breadcrumb>
        <BreadcrumbList>
          <BreadcrumbItem>
            <BreadcrumbLink asChild>
              <Link href={"/nodes" as Parameters<typeof Link>[0]["href"]}>资产</Link>
            </BreadcrumbLink>
          </BreadcrumbItem>
        </BreadcrumbList>
      </Breadcrumb>
      <div className="mt-6 rounded-xl border bg-card">
        <EmptyState
          icon={ServerCrash}
          title={isError ? "无法加载该节点" : "找不到这个节点"}
          description={isError ? message || "请稍后重试。" : "它可能已被删除，或你没有访问权限。"}
          action={
            <div className="flex gap-2">
              <Button variant="outline" onClick={onRetry}>
                <RotateCcw className="size-4" /> 重试
              </Button>
              <Button asChild>
                <Link href={"/nodes" as Parameters<typeof Link>[0]["href"]}>
                  <ArrowLeft className="size-4" /> 返回资产
                </Link>
              </Button>
            </div>
          }
        />
      </div>
    </div>
  )
}
