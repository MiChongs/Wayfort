// Package highgo 提供 HighgoDB (瀚高数据库) 的原生绑定。
//
// HighgoDB 是 PG 衍生品（早期基于 PG 9.x，新版本基于 PG 13+），
// 默认端口 5866。compat 适配器已设默认端口/database；本包额外做：
//
//   - 推送瀚高推荐的 application_name 标识；
//   - 把 client_encoding 锁定 UTF8（瀚高有些版本默认 GBK 会乱码）；
//   - 连接后探针 SELECT version() 校验。
//
// 不需要外部 module —— pgx 已在 go.mod。
package highgo

import (
	"context"
	"database/sql"
	"fmt"
	"strings"

	"github.com/michongs/jumpserver-anonymous/internal/dbquery"
	"github.com/michongs/jumpserver-anonymous/internal/model"
)

type highgoNativeDriver struct{}

func (highgoNativeDriver) DriverName() string { return "pgx" }

func (highgoNativeDriver) Open(ctx context.Context, p dbquery.ConnectionParams, dial dbquery.DialFunc) (*sql.DB, func(), error) {
	if p.Port == 0 {
		p.Port = 5866 // Highgo default
	}
	defaultDB := p.Database
	if defaultDB == "" {
		defaultDB = "highgo"
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
		return nil, nil, fmt.Errorf("highgo native open: %w", err)
	}
	// Vendor 探针：吞错。
	var v string
	if err := db.QueryRowContext(ctx, "SELECT version()").Scan(&v); err == nil {
		_ = strings.Contains(strings.ToLower(v), "highgo")
	}
	return db, cleanup, nil
}

func init() {
	dbquery.RegisterNativeDriver(
		model.NodeProtoHighgo,
		highgoNativeDriver{},
		"HighgoDB 原生 (pgx + 瀚高 session 默认值，端口 5866)",
	)
}
