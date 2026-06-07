// Curated Simple Icons brand registry. Each brand's vector + official colour is
// pulled from the `simple-icons` package at import time (named, tree-shaken
// imports — only the brands listed here ship in the bundle). Token value == the
// brand `slug`, resolvable via `<AppIcon icon="simple:postgresql">`.

import {
  siPostgresql,
  siMysql,
  siMariadb,
  siMariadbfoundation,
  siMongodb,
  siRedis,
  siSqlite,
  siElasticsearch,
  siOpensearch,
  siClickhouse,
  siInfluxdb,
  siNeo4j,
  siApachecassandra,
  siCockroachlabs,
  siSupabase,
  siRabbitmq,
  siApachekafka,
  siNginx,
  siApache,
  siTraefikproxy,
  siMinio,
  siEtcd,
  siConsul,
  siVault,
  siDocker,
  siKubernetes,
  siPodman,
  siHelm,
  siIstio,
  siPortainer,
  siProxmox,
  siVmware,
  siCitrix,
  siLinux,
  siUbuntu,
  siDebian,
  siRedhat,
  siCentos,
  siRockylinux,
  siAlmalinux,
  siSuse,
  siFedora,
  siArchlinux,
  siAlpinelinux,
  siApple,
  siFreebsd,
  siRaspberrypi,
  siGit,
  siGithub,
  siGitlab,
  siGitea,
  siJenkins,
  siTerraform,
  siAnsible,
  siPrometheus,
  siGrafana,
  siGnubash,
  siGo,
  siPython,
  siRust,
  siNodedotjs,
  siPhp,
  siCloudflare,
  siDigitalocean,
  siVercel,
  siGooglecloud,
  siAnthropic,
  siTelegram,
} from "simple-icons"

// The runtime shape we consume from each simple-icon export.
interface SimpleIconData {
  title: string
  slug: string
  hex: string
  path: string
}

export interface SimpleEntry {
  slug: string
  title: string
  hex: string
  path: string
  category: string
}

function entry(icon: SimpleIconData, category: string): SimpleEntry {
  return { slug: icon.slug, title: icon.title, hex: icon.hex, path: icon.path, category }
}

export const SIMPLE_ICONS: SimpleEntry[] = [
  // 数据库
  entry(siPostgresql, "数据库"),
  entry(siMysql, "数据库"),
  entry(siMariadb, "数据库"),
  entry(siMariadbfoundation, "数据库"),
  entry(siMongodb, "数据库"),
  entry(siRedis, "数据库"),
  entry(siSqlite, "数据库"),
  entry(siElasticsearch, "数据库"),
  entry(siOpensearch, "数据库"),
  entry(siClickhouse, "数据库"),
  entry(siInfluxdb, "数据库"),
  entry(siNeo4j, "数据库"),
  entry(siApachecassandra, "数据库"),
  entry(siCockroachlabs, "数据库"),
  entry(siSupabase, "数据库"),

  // 中间件 / 网关 / 消息
  entry(siRabbitmq, "中间件"),
  entry(siApachekafka, "中间件"),
  entry(siNginx, "中间件"),
  entry(siApache, "中间件"),
  entry(siTraefikproxy, "中间件"),
  entry(siMinio, "中间件"),
  entry(siEtcd, "中间件"),
  entry(siConsul, "中间件"),
  entry(siVault, "中间件"),

  // 容器 / 编排 / 虚拟化
  entry(siDocker, "容器"),
  entry(siKubernetes, "容器"),
  entry(siPodman, "容器"),
  entry(siHelm, "容器"),
  entry(siIstio, "容器"),
  entry(siPortainer, "容器"),
  entry(siProxmox, "容器"),
  entry(siVmware, "容器"),
  entry(siCitrix, "容器"),

  // 操作系统
  entry(siLinux, "系统"),
  entry(siUbuntu, "系统"),
  entry(siDebian, "系统"),
  entry(siRedhat, "系统"),
  entry(siCentos, "系统"),
  entry(siRockylinux, "系统"),
  entry(siAlmalinux, "系统"),
  entry(siSuse, "系统"),
  entry(siFedora, "系统"),
  entry(siArchlinux, "系统"),
  entry(siAlpinelinux, "系统"),
  entry(siApple, "系统"),
  entry(siFreebsd, "系统"),
  entry(siRaspberrypi, "系统"),

  // DevOps / 工具
  entry(siGit, "工具"),
  entry(siGithub, "工具"),
  entry(siGitlab, "工具"),
  entry(siGitea, "工具"),
  entry(siJenkins, "工具"),
  entry(siTerraform, "工具"),
  entry(siAnsible, "工具"),
  entry(siPrometheus, "工具"),
  entry(siGrafana, "工具"),
  entry(siGnubash, "工具"),

  // 语言
  entry(siGo, "语言"),
  entry(siPython, "语言"),
  entry(siRust, "语言"),
  entry(siNodedotjs, "语言"),
  entry(siPhp, "语言"),

  // 云 / 其它
  entry(siCloudflare, "云服务"),
  entry(siDigitalocean, "云服务"),
  entry(siVercel, "云服务"),
  entry(siGooglecloud, "云服务"),
  entry(siAnthropic, "云服务"),
  entry(siTelegram, "云服务"),
]

export const SIMPLE_MAP: Record<string, SimpleEntry> = Object.fromEntries(
  SIMPLE_ICONS.map((e) => [e.slug, e]),
)

export const SIMPLE_CATEGORIES = Array.from(new Set(SIMPLE_ICONS.map((e) => e.category)))
