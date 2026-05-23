// Package gbase8s wires GBase 8s (南大通用 TP 引擎，Informix 衍生) 官方
// Go 驱动到 dbquery。GBase 8s 不是 PG 衍生品——它继承自 Informix，使用
// IBM DRDA / Informix 私有 wire，绝不能用 pgx 通用 PG 驱动连接。默认
// 构建对 NodeProtoGBase8s 走 pgx 回落只为节点表单录入不报错；要真正
// 连通必须启用本 tag 并 vendor 厂商驱动。
//
//   go build -tags gbase8s_driver -o jumpserver ./cmd/jumpserver
//
//go:build gbase8s_driver
// +build gbase8s_driver

package gbase8s

import (
	"context"
	"database/sql"
	"fmt"

	_ "gitee.com/gbase/gbase8s-go" // operator 私服路径

	"github.com/michongs/jumpserver-anonymous/internal/dbquery"
	"github.com/michongs/jumpserver-anonymous/internal/model"
)

type gbase8sNativeDriver struct{}

func (gbase8sNativeDriver) DriverName() string { return "gbase8s" }

func (gbase8sNativeDriver) Open(_ context.Context, p dbquery.ConnectionParams, _ dbquery.DialFunc) (*sql.DB, func(), error) {
	host := p.Host
	if host == "" {
		host = "127.0.0.1"
	}
	port := p.Port
	if port == 0 {
		port = 9088 // GBase 8s default
	}
	dbname := p.Database
	if dbname == "" {
		dbname = "sysmaster"
	}
	// Informix-style DSN: `database@server:port/uname/password`. 厂商驱动
	// 通常接受简化的 URL 形式；按实际驱动文档调整。
	dsn := fmt.Sprintf("gbase8s://%s:%s@%s:%d/%s",
		p.User, p.Password, host, port, dbname)
	db, err := sql.Open("gbase8s", dsn)
	if err != nil {
		return nil, nil, fmt.Errorf("gbase8s native open: %w", err)
	}
	return db, func() {}, nil
}

func init() {
	dbquery.RegisterNativeDriver(
		model.NodeProtoGBase8s,
		gbase8sNativeDriver{},
		"GBase 8s 官方",
	)
}
