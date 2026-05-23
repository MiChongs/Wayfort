// Vastbase 真实驱动接入。
//
//   go build -tags vastbase_driver -o jumpserver ./cmd/jumpserver
//
//go:build vastbase_driver
// +build vastbase_driver

package main

import _ "github.com/michongs/jumpserver-anonymous/internal/dbquery/native/vastbase"
