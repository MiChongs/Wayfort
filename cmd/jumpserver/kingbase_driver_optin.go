// KingbaseES (人大金仓 KCI) 真实驱动接入。Operator 把厂商 Go 驱动
// 通过 go.mod replace 指到本地 vendor 后，启用：
//
//   go build -tags kingbase_driver -o jumpserver ./cmd/jumpserver
//
//go:build kingbase_driver
// +build kingbase_driver

package main

import _ "github.com/michongs/jumpserver-anonymous/internal/dbquery/native/kingbase"
