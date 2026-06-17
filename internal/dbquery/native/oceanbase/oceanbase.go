// Package oceanbase 提供 OceanBase 的原生绑定。
//
// OB 的核心问题：MySQL wire 协议下，连接到 OBProxy 时用户名必须是
//
//	USER@TENANT#CLUSTER
//
// 形式（USER@TENANT 也合法，省略 #CLUSTER 时 OBProxy 用集群默认值）。
// 直接把这串塞进 mysqldrv 的 DSN 会被 # 提前拆掉解析失败，必须 URL
// 转义 # → %23。本驱动接管 DSN 构造：
//
//   - User 字段已经带 "@TENANT" 或 "@TENANT#CLUSTER" → 转义并直传；
//   - User 不带 → 从 Extra["tenant"] / Extra["cluster"] 拼装；
//   - 都没有 → 退化到「user@sys」（OB 默认租户），仍可连标准部署。
//
// MySQL-mode 完全可用；Oracle-mode 需要厂商 obclient-go 驱动，那条路
// 通过 oceanbase_oracle_driver 构建标签开启（见同目录 oracle.go.disabled
// 模板）。本默认包不依赖外部 module，go-sql-driver/mysql 已在 go.mod。
package oceanbase

import (
	"context"
	"database/sql"
	"fmt"
	"net/url"
	"strings"

	"github.com/michongs/wayfort/internal/dbquery"
	"github.com/michongs/wayfort/internal/model"
)

type oceanbaseNativeDriver struct{}

func (oceanbaseNativeDriver) DriverName() string { return "mysql" }

func (oceanbaseNativeDriver) Open(_ context.Context, p dbquery.ConnectionParams, dial dbquery.DialFunc) (*sql.DB, func(), error) {
	if p.Port == 0 {
		p.Port = 2883 // OBProxy default; direct OBServer is 2881
	}
	// Build the OBProxy-friendly user identifier.
	user := composeOBUser(p.User, p.Extra)
	// Replace User in-place so OpenMySQL's DSN builder picks it up. The
	// pool retains the unescaped User in proto_options; we only mutate
	// a local copy.
	p.User = user
	// Strip tenant/cluster from Extra so they don't accidentally appear
	// as MySQL DSN params (the driver would reject "tenant=" anyway).
	pruned := map[string]string{}
	for k, v := range p.Extra {
		switch k {
		case "tenant", "cluster":
			continue
		default:
			pruned[k] = v
		}
	}
	p.Extra = pruned
	// Vendor-recommended MySQL DSN extras.
	extras := url.Values{}
	extras.Set("interpolateParams", "true") // OB has variable prepare quirks; safer with interpolation
	for k, v := range pruned {
		extras.Set(k, v)
	}
	db, cleanup, err := dbquery.OpenMySQL(p, dial, extras.Encode())
	if err != nil {
		return nil, nil, fmt.Errorf("oceanbase native open: %w", err)
	}
	return db, cleanup, nil
}

// composeOBUser turns a raw User + Extra (tenant/cluster) into the
// OBProxy-style USER@TENANT#CLUSTER form. Pre-formatted Users are
// honoured as-is; if the caller already wrote "user@tenant" we don't
// duplicate-append.
func composeOBUser(rawUser string, extra map[string]string) string {
	if strings.ContainsAny(rawUser, "@#") {
		return rawUser
	}
	tenant := extra["tenant"]
	cluster := extra["cluster"]
	if tenant == "" && cluster == "" {
		// Default tenant on stand-alone OBServer (no OBProxy) is "sys".
		// Operators on OBProxy without tenant context probably want
		// to set Extra.tenant explicitly; falling through to sys
		// keeps single-tenant test installs working.
		return rawUser
	}
	out := rawUser
	if tenant != "" {
		out = out + "@" + tenant
	}
	if cluster != "" {
		out = out + "#" + cluster
	}
	return out
}

func init() {
	dbquery.RegisterNativeDriver(
		model.NodeProtoOceanBase,
		oceanbaseNativeDriver{},
		"OceanBase 原生 (OBProxy tenant 路由，MySQL-mode)",
	)
}
