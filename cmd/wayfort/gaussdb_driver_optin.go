// 华为 GaussDB 商业版 真实驱动接入。openGauss 是社区版（见
// opengauss_driver_optin.go），GaussDB 是华为云收费 SKU。
//
//   go build -tags gaussdb_driver -o wayfort ./cmd/wayfort
//
//go:build gaussdb_driver
// +build gaussdb_driver

package main

import _ "github.com/michongs/wayfort/internal/dbquery/native/gaussdb"
