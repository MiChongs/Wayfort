// Package kingbase wires KingbaseES (人大金仓) 官方 Go 驱动到 dbquery
// 原生驱动注册表。Operators 把 KCI 私服模块（金仓客户支持站下载）放进
// go.mod 后，启用 `kingbase_driver` 构建标签即生效。
//
// 默认构建不引入此包；KingbaseES 节点会走 pgx 通用 PG 线协议——能连
// 通明文 / MD5 认证的实例，但启用 KCI 自定义协议（金仓加密握手、行级
// 安全策略下发等）必须走官方驱动。
//
// 启用流程：
//
//  1. 从金仓客户支持站取得 Go 驱动 tarball（命名形如 kbgo-x.x.x.tar.gz）。
//  2. `mkdir -p third_party/kingbase` 并解压。
//  3. go.mod 加 replace：
//     replace gitee.com/kingbase/kbgo => ./third_party/kingbase
//  4. 启用：
//     go build -tags kingbase_driver -o jumpserver ./cmd/jumpserver
//
// 如果厂商 module 路径不是 `gitee.com/kingbase/kbgo`，把下面的 import
// 路径替换为实际路径即可——其余样板代码无需改动。
//
//go:build kingbase_driver
// +build kingbase_driver

package kingbase

import (
	"context"
	"database/sql"
	"fmt"
	"net/url"

	_ "gitee.com/kingbase/kbgo" // operator 私服路径；按需替换

	"github.com/michongs/jumpserver-anonymous/internal/dbquery"
	"github.com/michongs/jumpserver-anonymous/internal/model"
)

// kingbaseNativeDriver opens KCI 驱动注册的 "kingbase" 名下的 DSN。
// 注意 dial-func 在此处不可注入 — KCI 驱动用其内部 TCP 直连；如果您
// 的部署需要走 gateway 的 proxy chain，让 gateway 把 KingbaseES 暴露
// 在本地端口（同 dbcli 终端流程一致），再把 ConnectionParams.Host /
// Port 指向本地端口。
type kingbaseNativeDriver struct{}

func (kingbaseNativeDriver) DriverName() string { return "kingbase" }

func (kingbaseNativeDriver) Open(_ context.Context, p dbquery.ConnectionParams, _ dbquery.DialFunc) (*sql.DB, func(), error) {
	dsn := buildDSN(p)
	db, err := sql.Open("kingbase", dsn)
	if err != nil {
		return nil, nil, fmt.Errorf("kingbase native open: %w", err)
	}
	return db, func() {}, nil
}

func buildDSN(p dbquery.ConnectionParams) string {
	host := p.Host
	if host == "" {
		host = "127.0.0.1"
	}
	port := p.Port
	if port == 0 {
		port = 54321 // KingbaseES 默认端口
	}
	dbname := p.Database
	if dbname == "" {
		dbname = "TEST"
	}
	params := url.Values{}
	params.Set("sslmode", "disable")
	for k, v := range p.Extra {
		params.Set(k, v)
	}
	return fmt.Sprintf("kingbase://%s:%s@%s:%d/%s?%s",
		url.QueryEscape(p.User), url.QueryEscape(p.Password),
		host, port, url.PathEscape(dbname), params.Encode())
}

func init() {
	dbquery.RegisterNativeDriver(
		model.NodeProtoKingbase,
		kingbaseNativeDriver{},
		"KingbaseES 官方 (KCI)",
	)
}
