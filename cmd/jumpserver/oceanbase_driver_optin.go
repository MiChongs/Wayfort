// OceanBase 官方驱动接入（OBProxy tenant 路由 + Oracle-mode）。
// 默认构建对 OceanBase 节点走 go-sql-driver/mysql 直连 MySQL-mode；
// 启用本 tag 后切到厂商驱动，获得 tenant/cluster 路由能力。
//
//   go build -tags oceanbase_driver -o jumpserver ./cmd/jumpserver
//
//go:build oceanbase_driver
// +build oceanbase_driver

package main

import _ "github.com/michongs/jumpserver-anonymous/internal/dbquery/native/oceanbase"
