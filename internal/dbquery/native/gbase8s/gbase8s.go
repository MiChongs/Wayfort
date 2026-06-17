// Package gbase8s 提供 GBase 8s (南大通用 Informix 衍生 TP 引擎) 的
// 原生绑定。
//
// 重点：**GBase 8s 不是 PG 衍生品**，使用 IBM DRDA / Informix 私有
// wire 协议，pgx 完全连不通。没有公开发行的 Go Informix 驱动。本
// 包按以下策略最大化可用性：
//
//   1. 启动时探测 database/sql 是否已注册名 "gbase8s"（operator 通过
//      build-time side-effect import 或外部 plugin 注入）；
//   2. 注册时无视探测结果——延迟到 Open 才检查驱动可用性，让前端
//      仍能在 EngineCatalog 里看到 GBase 8s 这个引擎；
//   3. Open 时若驱动未注册，返回明确错误指引 operator 接入路径。
//
// operator 启用方式：
//
//   import _ "your.private.path/gbase8s-go-driver"   // 在另一个文件里
//
//   该驱动通过 database/sql.Register("gbase8s", ...) 注册自己即可，
//   本包的 sql.Open("gbase8s", dsn) 即生效。
package gbase8s

import (
	"context"
	"database/sql"
	"errors"
	"fmt"

	"github.com/michongs/wayfort/internal/dbquery"
	"github.com/michongs/wayfort/internal/model"
)

type gbase8sNativeDriver struct{}

func (gbase8sNativeDriver) DriverName() string { return "gbase8s" }

func (gbase8sNativeDriver) Open(_ context.Context, p dbquery.ConnectionParams, _ dbquery.DialFunc) (*sql.DB, func(), error) {
	if !driverRegistered("gbase8s") {
		return nil, nil, errors.New(
			"gbase8s: 未在 database/sql 注册名为 \"gbase8s\" 的驱动；" +
				"GBase 8s 走 Informix DRDA 私有协议，pgx 无法兼容。" +
				"请在 cmd/wayfort 里 side-effect import 厂商 Go 驱动" +
				"(联系南大通用客户支持获取)，注册名 \"gbase8s\" 即可。",
		)
	}
	port := p.Port
	if port == 0 {
		port = 9088
	}
	dbname := p.Database
	if dbname == "" {
		dbname = "sysmaster"
	}
	// Informix-style URL DSN. 不同厂商驱动 DSN 形式不一，operator
	// 可以通过 Extra 完全替换：Extra["dsn"] = "..." 时直接使用。
	dsn := p.Extra["dsn"]
	if dsn == "" {
		dsn = fmt.Sprintf("gbase8s://%s:%s@%s:%d/%s",
			p.User, p.Password, p.Host, port, dbname)
	}
	db, err := sql.Open("gbase8s", dsn)
	if err != nil {
		return nil, nil, fmt.Errorf("gbase8s native open: %w", err)
	}
	return db, func() {}, nil
}

// driverRegistered 检查 database/sql 全局注册表是否有名为 name 的驱动。
// sql.Drivers() 返回所有已注册名称的快照，O(n) 扫描是常数级，调用频
// 度非常低（每次开池一次），不需要缓存。
func driverRegistered(name string) bool {
	for _, n := range sql.Drivers() {
		if n == name {
			return true
		}
	}
	return false
}

func init() {
	dbquery.RegisterNativeDriver(
		model.NodeProtoGBase8s,
		gbase8sNativeDriver{},
		"GBase 8s 原生 (Informix DRDA，需要 operator side-effect import 厂商驱动)",
	)
}
