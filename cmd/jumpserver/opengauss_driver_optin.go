// openGauss 官方驱动接入：把 internal/dbquery/native/opengauss 子包在
// `opengauss_driver` 构建标签下链入主二进制。
//
// 启用方式：
//
//	GOPROXY=https://goproxy.cn,direct go build -tags opengauss_driver -o jumpserver ./cmd/jumpserver
//
// 同时启用多个国产驱动：
//
//	go build -tags "dm_driver opengauss_driver" -o jumpserver ./cmd/jumpserver
//
// 不加 tag 时 openGauss 节点会走 pgx 通用 PG 线协议——能连通明文/MD5
// 配置的实例，但 SM3 / SHA-256 password_encryption 集群必须走官方驱动。
//
//go:build opengauss_driver
// +build opengauss_driver

package main

import _ "github.com/michongs/jumpserver-anonymous/internal/dbquery/native/opengauss"
