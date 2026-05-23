// Package vastbase wires Vastbase (海量数据) 官方 Go 驱动到 dbquery。
// 默认 pgx 通用线协议已能连大多数 Vastbase 实例；本子包用于启用厂商
// 加密握手 / 行级安全等定制协议（需要 vastbase_driver 构建标签）。
//
//   go build -tags vastbase_driver -o jumpserver ./cmd/jumpserver
//
// Operator 把厂商驱动通过 go.mod replace 指到本地 vendor，再启用 tag
// 即可。
//
//go:build vastbase_driver
// +build vastbase_driver

package vastbase

import (
	"context"
	"database/sql"
	"fmt"
	"net/url"

	_ "gitee.com/vastbase/vbgo" // operator 私服路径；按需替换

	"github.com/michongs/jumpserver-anonymous/internal/dbquery"
	"github.com/michongs/jumpserver-anonymous/internal/model"
)

type vastbaseNativeDriver struct{}

func (vastbaseNativeDriver) DriverName() string { return "vastbase" }

func (vastbaseNativeDriver) Open(_ context.Context, p dbquery.ConnectionParams, _ dbquery.DialFunc) (*sql.DB, func(), error) {
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
	for k, v := range p.Extra {
		q.Set(k, v)
	}
	dsn := fmt.Sprintf("vastbase://%s:%s@%s:%d/%s?%s",
		url.QueryEscape(p.User), url.QueryEscape(p.Password),
		host, port, url.PathEscape(dbname), q.Encode())
	db, err := sql.Open("vastbase", dsn)
	if err != nil {
		return nil, nil, fmt.Errorf("vastbase native open: %w", err)
	}
	return db, func() {}, nil
}

func init() {
	dbquery.RegisterNativeDriver(
		model.NodeProtoVastbase,
		vastbaseNativeDriver{},
		"Vastbase 官方",
	)
}
