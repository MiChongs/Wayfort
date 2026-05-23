// GBase 8s (南大通用 Informix 系) 真实驱动接入。**GBase 8s 不是 PG
// 衍生品**——默认 pgx 回落只是让节点表单录入不报错，要真正连通必须
// 启用本 tag 并 vendor 厂商 Go 驱动。
//
//   go build -tags gbase8s_driver -o jumpserver ./cmd/jumpserver
//
//go:build gbase8s_driver
// +build gbase8s_driver

package main

import _ "github.com/michongs/jumpserver-anonymous/internal/dbquery/native/gbase8s"
