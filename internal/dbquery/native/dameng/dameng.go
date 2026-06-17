// Package dameng wires the official 达梦 DM8 Go driver into the dbquery
// native registry. Only compiled when the build is invoked with the
// `dm_driver` build tag, so the default wayfort binary stays
// portable on environments that cannot reach gitee.com (CI, air-gapped
// installations, etc.).
//
// To enable real DM8 connectivity:
//
//	GOPROXY=https://goproxy.cn,direct go build -tags dm_driver -o wayfort ./cmd/wayfort
//
// The vendor module `gitee.com/chunanyong/dm` registers itself with
// database/sql under the driver name "dm" via its own init(). This
// package's init() then calls dbquery.RegisterNativeDriver so that
// damengAdapter.Driver() returns the registry entry instead of the
// stub that ships with the default build.
//
//go:build dm_driver
// +build dm_driver

package dameng

import (
	"context"
	"database/sql"
	"fmt"

	_ "gitee.com/chunanyong/dm" // registers driver "dm" with database/sql

	"github.com/michongs/wayfort/internal/dbquery"
	"github.com/michongs/wayfort/internal/model"
)

// damengNativeDriver opens a connection using the gitee-hosted driver.
// The DSN matches what the upstream README documents:
//
//	dm://USER:PASSWORD@HOST:PORT?schema=...&autoCommit=true
//
// We deliberately mirror the legacy damengDriver's DSN shape so the
// caller-side behaviour (the executor's COMMIT/ROLLBACK boundaries,
// the proxy chain's local port forward expectation) doesn't change
// across the native/stub boundary.
type damengNativeDriver struct{}

func (damengNativeDriver) DriverName() string { return "dm" }

func (damengNativeDriver) Open(_ context.Context, params dbquery.ConnectionParams, _ dbquery.DialFunc) (*sql.DB, func(), error) {
	dsn := buildDSN(params)
	db, err := sql.Open("dm", dsn)
	if err != nil {
		return nil, nil, fmt.Errorf("dameng native open: %w", err)
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
		port = 5236
	}
	dsn := fmt.Sprintf("dm://%s:%s@%s:%d", p.User, p.Password, host, port)
	extras := map[string]string{
		"autoCommit": "true",
	}
	for k, v := range p.Extra {
		extras[k] = v
	}
	if p.Database != "" {
		extras["schema"] = p.Database
	}
	if len(extras) > 0 {
		dsn += "?" + encodeExtras(extras)
	}
	return dsn
}

// encodeExtras avoids dragging in net/url for one-shot key=value joins.
// We URL-escape values manually to survive special chars in passwords
// or schema names with hyphens.
func encodeExtras(m map[string]string) string {
	out := ""
	for k, v := range m {
		if out != "" {
			out += "&"
		}
		out += k + "=" + escape(v)
	}
	return out
}

func escape(s string) string {
	const hex = "0123456789ABCDEF"
	buf := make([]byte, 0, len(s))
	for i := 0; i < len(s); i++ {
		c := s[i]
		switch {
		case 'a' <= c && c <= 'z', 'A' <= c && c <= 'Z', '0' <= c && c <= '9',
			c == '-' || c == '_' || c == '.' || c == '~':
			buf = append(buf, c)
		default:
			buf = append(buf, '%', hex[c>>4], hex[c&0x0f])
		}
	}
	return string(buf)
}

func init() {
	dbquery.RegisterNativeDriver(
		model.NodeProtoDameng,
		damengNativeDriver{},
		"达梦官方 (gitee.com/chunanyong/dm)",
	)
}
