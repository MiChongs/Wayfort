// Package oceanbase wires OceanBase 官方 Go 驱动（OBProxy tenant 路由
// + OB Oracle-mode 方言）到 dbquery。默认构建对 NodeProtoOceanBase 走
// go-sql-driver/mysql 直连 OBServer 的 MySQL-mode tenant——已能跑通 90%
// 的 OLTP 查询。本 tag 启用后切换到厂商驱动，获得：
//
//   - OBProxy tenant=xxx#cluster=yyy 路由
//   - OB Oracle-mode（PLSQL / 双 quote 标识符 / 序列）
//   - 厂商自有的 weak-consistency-read 调度提示
//
//   go build -tags oceanbase_driver -o jumpserver ./cmd/jumpserver
//
//go:build oceanbase_driver
// +build oceanbase_driver

package oceanbase

import (
	"context"
	"database/sql"
	"fmt"
	"strings"

	_ "github.com/oceanbase/obclient-go" // operator 私服路径；按需替换

	"github.com/michongs/jumpserver-anonymous/internal/dbquery"
	"github.com/michongs/jumpserver-anonymous/internal/model"
)

type oceanbaseNativeDriver struct{}

func (oceanbaseNativeDriver) DriverName() string { return "oceanbase" }

func (oceanbaseNativeDriver) Open(_ context.Context, p dbquery.ConnectionParams, _ dbquery.DialFunc) (*sql.DB, func(), error) {
	host := p.Host
	if host == "" {
		host = "127.0.0.1"
	}
	port := p.Port
	if port == 0 {
		port = 2883 // OBProxy default; OBServer 直连用 2881
	}
	// OB 用户名结构：USER@TENANT#CLUSTER。允许 operator 直接在 User
	// 字段里写完整形式，或通过 Extra.tenant / Extra.cluster 拼装。
	user := p.User
	if !strings.Contains(user, "@") {
		if tenant := p.Extra["tenant"]; tenant != "" {
			user = user + "@" + tenant
		}
		if cluster := p.Extra["cluster"]; cluster != "" {
			user = user + "#" + cluster
		}
	}
	dbname := p.Database
	if dbname == "" {
		dbname = "oceanbase"
	}
	dsn := fmt.Sprintf("%s:%s@tcp(%s:%d)/%s?parseTime=true&loc=Local",
		user, p.Password, host, port, dbname)
	for k, v := range p.Extra {
		if k == "tenant" || k == "cluster" {
			continue
		}
		dsn += "&" + k + "=" + v
	}
	db, err := sql.Open("oceanbase", dsn)
	if err != nil {
		return nil, nil, fmt.Errorf("oceanbase native open: %w", err)
	}
	return db, func() {}, nil
}

func init() {
	dbquery.RegisterNativeDriver(
		model.NodeProtoOceanBase,
		oceanbaseNativeDriver{},
		"OceanBase 官方 (tenant 路由)",
	)
}
