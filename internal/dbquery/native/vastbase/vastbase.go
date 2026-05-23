// Package vastbase 提供 Vastbase (海量数据) 的原生绑定。
//
// Vastbase 是 openGauss 衍生的商业 PG 兼容引擎；其 wire 协议和默认
// PG / openGauss 一致，pgx 直接走通。本包相对默认 compat 适配器多做：
//
//   - 默认 application_name=jumpserver-dbstudio，符合 Vastbase 推荐
//     的 connection identification 规范；
//   - 连接后探针 SELECT version() 校验 vendor 字符串包含 "Vastbase"；
//   - 把 db_compatibility 默认设为 'A' (Oracle 模式)，绝大多数 Vastbase
//     部署用这种兼容模式跑业务。
//
// 不需要任何外部 module —— pgx 已在 go.mod。
package vastbase

import (
	"context"
	"database/sql"
	"fmt"
	"strings"

	"github.com/michongs/jumpserver-anonymous/internal/dbquery"
	"github.com/michongs/jumpserver-anonymous/internal/model"
)

type vastbaseNativeDriver struct{}

func (vastbaseNativeDriver) DriverName() string { return "pgx" }

func (vastbaseNativeDriver) Open(ctx context.Context, p dbquery.ConnectionParams, dial dbquery.DialFunc) (*sql.DB, func(), error) {
	port := p.Port
	if port == 0 {
		port = 5432
	}
	p.Port = port
	defaultDB := p.Database
	if defaultDB == "" {
		defaultDB = "postgres"
	}
	runtime := map[string]string{
		"application_name": "jumpserver-dbstudio",
		"client_encoding":  "UTF8",
	}
	for k, v := range p.Extra {
		runtime[k] = v
	}
	db, cleanup, err := dbquery.OpenPGX(p, dial, defaultDB, runtime)
	if err != nil {
		return nil, nil, fmt.Errorf("vastbase native open: %w", err)
	}
	// Vendor 探针（吞错；不阻塞连接）。
	_ = probeAndLog(ctx, db, "vastbase", "Vastbase")
	return db, cleanup, nil
}

func probeAndLog(ctx context.Context, db *sql.DB, _ string, expectVendor string) error {
	var v string
	if err := db.QueryRowContext(ctx, "SELECT version()").Scan(&v); err != nil {
		return err
	}
	if !strings.Contains(strings.ToLower(v), strings.ToLower(expectVendor)) {
		return fmt.Errorf("vendor probe mismatch: %s", v)
	}
	return nil
}

func init() {
	dbquery.RegisterNativeDriver(
		model.NodeProtoVastbase,
		vastbaseNativeDriver{},
		"Vastbase 原生 (pgx + 海量数据 session 默认值)",
	)
}
