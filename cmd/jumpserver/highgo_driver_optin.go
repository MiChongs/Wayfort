// HighgoDB (瀚高数据库) 真实驱动接入。
//
//   go build -tags highgo_driver -o jumpserver ./cmd/jumpserver
//
//go:build highgo_driver
// +build highgo_driver

package main

import _ "github.com/michongs/jumpserver-anonymous/internal/dbquery/native/highgo"
