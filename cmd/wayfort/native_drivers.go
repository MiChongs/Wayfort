// 国产数据库 always-active 原生绑定。
//
// 这些子包只依赖 pgx (PG-wire) 或 go-sql-driver/mysql (MySQL-wire)
// —— 两者都已经在 go.mod。无外部 module 拉取要求，可以在所有构建
// 环境（CI / 离线 / 公司内网）下默认启用，所以无 build tag。
//
// 每个子包通过 init() 调用 dbquery.RegisterNativeDriver(...)，把
// vendor-specific 的 Driver 实现注册到注册表。compat 适配器的
// Driver() 会优先返回注册表条目，跳过通用 pgx / mysql 默认路径。
//
// 需要外部 gitee / 厂商 module 的绑定（达梦 / openGauss SM3 / GaussDB
// 商业版）仍走各自的 *_driver_optin.go 文件——build-tag 开关启用。
//
// 顺序：side-effect import 触发包级 init()。这些 init() 之间无依赖
// （都是独立 protocol），顺序不重要。

package main

import (
	_ "github.com/michongs/wayfort/internal/dbquery/native/kingbase"
	_ "github.com/michongs/wayfort/internal/dbquery/native/vastbase"
	_ "github.com/michongs/wayfort/internal/dbquery/native/highgo"
	_ "github.com/michongs/wayfort/internal/dbquery/native/oceanbase"
	_ "github.com/michongs/wayfort/internal/dbquery/native/gbase8s"
)
