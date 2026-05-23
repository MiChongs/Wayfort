// Package highgo wires HighgoDB (瀚高数据库) 官方 Go 驱动到 dbquery。
//
//   go build -tags highgo_driver -o jumpserver ./cmd/jumpserver
//
//go:build highgo_driver
// +build highgo_driver

package highgo

import (
	"context"
	"database/sql"
	"fmt"
	"net/url"

	_ "gitee.com/highgo/highgo-go" // operator 私服路径

	"github.com/michongs/jumpserver-anonymous/internal/dbquery"
	"github.com/michongs/jumpserver-anonymous/internal/model"
)

type highgoNativeDriver struct{}

func (highgoNativeDriver) DriverName() string { return "highgo" }

func (highgoNativeDriver) Open(_ context.Context, p dbquery.ConnectionParams, _ dbquery.DialFunc) (*sql.DB, func(), error) {
	host := p.Host
	if host == "" {
		host = "127.0.0.1"
	}
	port := p.Port
	if port == 0 {
		port = 5866 // Highgo default
	}
	dbname := p.Database
	if dbname == "" {
		dbname = "highgo"
	}
	q := url.Values{}
	q.Set("sslmode", "disable")
	for k, v := range p.Extra {
		q.Set(k, v)
	}
	dsn := fmt.Sprintf("highgo://%s:%s@%s:%d/%s?%s",
		url.QueryEscape(p.User), url.QueryEscape(p.Password),
		host, port, url.PathEscape(dbname), q.Encode())
	db, err := sql.Open("highgo", dsn)
	if err != nil {
		return nil, nil, fmt.Errorf("highgo native open: %w", err)
	}
	return db, func() {}, nil
}

func init() {
	dbquery.RegisterNativeDriver(
		model.NodeProtoHighgo,
		highgoNativeDriver{},
		"HighgoDB 官方",
	)
}
