// Package opengauss wires the official openGauss Go driver (with SHA-256
// and SM3 password auth) into the dbquery native registry. Only built
// when `-tags opengauss_driver` is on the go build line.
//
// Why a native driver matters here: vanilla pgx does NOT speak
// openGauss' SHA-256-derived password handshake by default — most
// production openGauss clusters require it (sm3_password_encryption_type
// = 2). The vendor driver `gitee.com/opengauss/openGauss-connector-go-pq`
// implements that handshake. With the default pgx wire driver the
// connection succeeds only against clusters configured for plain MD5
// or trust auth — not realistic for production.
//
//	GOPROXY=https://goproxy.cn,direct go build -tags opengauss_driver -o wayfort ./cmd/wayfort
//
//go:build opengauss_driver
// +build opengauss_driver

package opengauss

import (
	"context"
	"database/sql"
	"fmt"
	"net/url"

	_ "gitee.com/opengauss/openGauss-connector-go-pq" // registers driver "opengauss"

	"github.com/michongs/wayfort/internal/dbquery"
	"github.com/michongs/wayfort/internal/model"
)

// opengaussNativeDriver opens through the vendor-provided lib/pq-style
// driver. The DSN follows libpq conventions; we set sslmode=disable as
// the default because most internal openGauss deployments don't have
// TLS provisioned — operators flip it via proto_options.Extra when
// they do.
type opengaussNativeDriver struct{}

func (opengaussNativeDriver) DriverName() string { return "opengauss" }

func (opengaussNativeDriver) Open(_ context.Context, params dbquery.ConnectionParams, _ dbquery.DialFunc) (*sql.DB, func(), error) {
	dsn := buildDSN(params)
	db, err := sql.Open("opengauss", dsn)
	if err != nil {
		return nil, nil, fmt.Errorf("opengauss native open: %w", err)
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
		port = 5432
	}
	dbname := p.Database
	if dbname == "" {
		dbname = "postgres"
	}
	params := url.Values{}
	params.Set("sslmode", "disable")
	// Operator overrides via Extra. Common keys: sslmode, target_session_attrs,
	// connect_timeout, application_name, search_path.
	for k, v := range p.Extra {
		params.Set(k, v)
	}
	return fmt.Sprintf("postgres://%s:%s@%s:%d/%s?%s",
		url.QueryEscape(p.User), url.QueryEscape(p.Password),
		host, port, url.PathEscape(dbname), params.Encode())
}

func init() {
	dbquery.RegisterNativeDriver(
		model.NodeProtoOpenGauss,
		opengaussNativeDriver{},
		"openGauss 官方 (SM3/SHA-256 auth)",
	)
}
