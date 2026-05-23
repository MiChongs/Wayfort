// Package gaussdb wires 华为 GaussDB 商业版 官方 Go 驱动到 dbquery。
// openGauss 是社区开源版（gitee 公网可达，见 native/opengauss）；GaussDB
// 是华为商业 SKU，驱动通过华为云客户支持渠道分发，需要 operator vendoring。
//
//   go build -tags gaussdb_driver -o jumpserver ./cmd/jumpserver
//
//go:build gaussdb_driver
// +build gaussdb_driver

package gaussdb

import (
	"context"
	"database/sql"
	"fmt"
	"net/url"

	_ "huaweicloud.com/gaussdb/gaussdbgo" // operator 私服路径

	"github.com/michongs/jumpserver-anonymous/internal/dbquery"
	"github.com/michongs/jumpserver-anonymous/internal/model"
)

type gaussdbNativeDriver struct{}

func (gaussdbNativeDriver) DriverName() string { return "gaussdb" }

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
	// target_session_attrs=read-write 让 driver 自动避开 standby；常见
	// GaussDB 部署是主备复制对，operator 可以在 proto_options 里覆盖。
	q.Set("target_session_attrs", "read-write")
	for k, v := range p.Extra {
		q.Set(k, v)
	}
	dsn := fmt.Sprintf("gaussdb://%s:%s@%s:%d/%s?%s",
		url.QueryEscape(p.User), url.QueryEscape(p.Password),
		host, port, url.PathEscape(dbname), q.Encode())
	db, err := sql.Open("gaussdb", dsn)
	if err != nil {
		return nil, nil, fmt.Errorf("gaussdb native open: %w", err)
	}
	return db, func() {}, nil
}

func init() {
	dbquery.RegisterNativeDriver(
		model.NodeProtoGaussDB,
		gaussdbNativeDriver{},
		"GaussDB 商业版",
	)
}
