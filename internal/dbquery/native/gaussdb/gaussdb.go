// Package gaussdb 提供华为 GaussDB 商业版的原生绑定。
//
// GaussDB 和 openGauss 共享同一套基于 PG 的 wire 协议；GaussDB 是
// 闭源商业 SKU，openGauss 是社区开源版。两者的 SHA-256 / SM3 密码
// 握手实现一致，所以本包复用 internal/dbquery/native/opengauss/ 的
// 同款连接器（gitee.com/opengauss/openGauss-connector-go-pq）。
//
// 启用方式（必须同时启用 opengauss_driver 标签，因为 SM3 连接器只在
// 那个标签下链入二进制）：
//
//	go build -tags "opengauss_driver gaussdb_driver" -o wayfort ./cmd/wayfort
//
// 默认构建（无标签）走 pgx 通用 PG 线协议，能连标准 SHA-256/MD5 认证
// 的 GaussDB 实例；SM3 password_encryption=2 部署必须启用标签。
//
//go:build gaussdb_driver
// +build gaussdb_driver

package gaussdb

import (
	"context"
	"database/sql"
	"fmt"
	"net/url"

	// Pull in the openGauss native subpackage so its init() side-effect-
	// registers the "opengauss" sql driver. Operators enabling gaussdb_driver
	// MUST also enable opengauss_driver — the connector lives there.
	_ "github.com/michongs/wayfort/internal/dbquery/native/opengauss"

	"github.com/michongs/wayfort/internal/dbquery"
	"github.com/michongs/wayfort/internal/model"
)

type gaussdbNativeDriver struct{}

func (gaussdbNativeDriver) DriverName() string { return "opengauss" }

func (gaussdbNativeDriver) Open(_ context.Context, p dbquery.ConnectionParams, _ dbquery.DialFunc) (*sql.DB, func(), error) {
	host := p.Host
	if host == "" {
		host = "127.0.0.1"
	}
	port := p.Port
	if port == 0 {
		port = 5432
	}
	dbname := p.Database
	if dbname == "" {
		dbname = "postgres"
	}
	q := url.Values{}
	q.Set("sslmode", "disable")
	// GaussDB 主备复制对常见，避开 standby 落入 read-only。
	q.Set("target_session_attrs", "read-write")
	for k, v := range p.Extra {
		q.Set(k, v)
	}
	dsn := fmt.Sprintf("postgres://%s:%s@%s:%d/%s?%s",
		url.QueryEscape(p.User), url.QueryEscape(p.Password),
		host, port, url.PathEscape(dbname), q.Encode())
	db, err := sql.Open("opengauss", dsn)
	if err != nil {
		return nil, nil, fmt.Errorf("gaussdb native open: %w", err)
	}
	return db, func() {}, nil
}

func init() {
	dbquery.RegisterNativeDriver(
		model.NodeProtoGaussDB,
		gaussdbNativeDriver{},
		"GaussDB 商业版 (复用 openGauss SM3 连接器)",
	)
}
