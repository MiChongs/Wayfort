// 达梦 DM8 真实驱动接入。Phase 28：把 init() 注册迁移到
// internal/dbquery/native/dameng/，这个文件只负责在 `dm_driver` 构建标签
// 下把该子包链入主二进制（Go 不会自动链入未被引用的包）。
//
// 启用方式：
//
//	GOPROXY=https://goproxy.cn,direct go build -tags dm_driver -o jumpserver ./cmd/jumpserver
//
// 启用后 internal/dbquery/native/dameng.init() 会向 dbquery.RegisterNativeDriver
// 注册 "dm" 名下的官方驱动；damengAdapter.Driver() 命中即返回它。
// 默认构建不加 tag 时此文件不参与编译，整个仓库继续可以离线 / 无 gitee
// 访问的环境下构建出可用二进制（达梦节点连接会立即返回带提示语的错误）。
//
//go:build dm_driver
// +build dm_driver

package main

import _ "github.com/michongs/jumpserver-anonymous/internal/dbquery/native/dameng"
