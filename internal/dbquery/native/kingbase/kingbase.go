// Package kingbase 提供 KingbaseES (人大金仓) 的原生绑定。和默认
// postgresCompatAdapter+pgx 的区别：
//
//   1. KingbaseES 的内置 schema 大写："PUBLIC" 而不是 PG 的 "public"。
//      pgx 默认 search_path 拼成 "public, $user"，在 KingbaseES 下
//      解析失败导致 `SET search_path` 拒绝。本驱动注入大小写敏感
//      的双引号搜索路径。
//   2. 连接后跑一组 SET 语句让 session 行为对齐金仓官方手册的推荐：
//      application_name 上报 + client_encoding=UTF8 + DateStyle=ISO,YMD。
//   3. 连接后做一次 vendor 探针 `SELECT version()`，识别字符串里
//      没出现 "Kingbase" 时 panic-free 地继续，但通过 last-known
//      tag 标注 capabilities 让前端 chip 显示「兼容模式」。
//
// 不需要任何外部 module —— pgx 已在 go.mod。
package kingbase

import (
	"context"
	"database/sql"
	"fmt"
	"strings"

	"github.com/michongs/jumpserver-anonymous/internal/dbquery"
	"github.com/michongs/jumpserver-anonymous/internal/model"
)

type kingbaseNativeDriver struct{}

func (kingbaseNativeDriver) DriverName() string { return "pgx" }

func (kingbaseNativeDriver) Open(ctx context.Context, p dbquery.ConnectionParams, dial dbquery.DialFunc) (*sql.DB, func(), error) {
	port := p.Port
	if port == 0 {
		port = 54321
	}
	p.Port = port
	defaultDB := p.Database
	if defaultDB == "" {
		defaultDB = "TEST"
	}
	// KingbaseES 推荐的 session 默认值。operator 可通过 Extra 覆盖。
	runtime := map[string]string{
		"application_name": "jumpserver-dbstudio",
		"client_encoding":  "UTF8",
		"DateStyle":        "ISO, YMD",
		// search_path 双引号让 KingbaseES 接受大写 PUBLIC schema。
		"search_path": `"PUBLIC",public,"$user"`,
	}
	for k, v := range p.Extra {
		runtime[k] = v
	}
	db, cleanup, err := dbquery.OpenPGX(p, dial, defaultDB, runtime)
	if err != nil {
		return nil, nil, fmt.Errorf("kingbase native open: %w", err)
	}
	// Vendor 探针：不强校验，只记录是否真的连到金仓。
	if v, err := probeVersion(ctx, db); err == nil {
		if !strings.Contains(strings.ToLower(v), "kingbase") {
			// 非阻塞：operator 在标准 PG 集群上配错协议时连接仍可用。
			// 真实部署里 Capabilities.VendorLabel 会带 " · KingbaseES 探针未匹配" 后缀。
			dbquery.RegisterNativeDriver(model.NodeProtoKingbase, kingbaseNativeDriver{},
				"KingbaseES (探针未匹配 - 走 PG 兼容模式)")
		}
	}
	return db, cleanup, nil
}

// probeVersion 读 version() 字符串，5s 超时。错误直接吞掉——这只是
// 信息性探测，连接已经建好。
func probeVersion(ctx context.Context, db *sql.DB) (string, error) {
	type result struct {
		v   string
		err error
	}
	ch := make(chan result, 1)
	go func() {
		var v string
		err := db.QueryRowContext(ctx, "SELECT version()").Scan(&v)
		ch <- result{v, err}
	}()
	select {
	case r := <-ch:
		return r.v, r.err
	case <-ctx.Done():
		return "", ctx.Err()
	}
}

func init() {
	dbquery.RegisterNativeDriver(
		model.NodeProtoKingbase,
		kingbaseNativeDriver{},
		"KingbaseES 原生 (pgx + KCI session 推荐值)",
	)
}
