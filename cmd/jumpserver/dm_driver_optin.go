// 达梦 DM8 真实连接器的可选接入文件 (Phase 23)。
//
// 默认构建不引入：达梦的 Go 驱动托管在 gitee.com/chunanyong/dm，
// GOPROXY 经常无法从 CI / 公司内网 / 离线环境拉取。这个文件用 build
// tag `dm_driver` 守住——只有在 build 时加 `-tags dm_driver` 才会
// side-effect 导入驱动包，把它注册到 database/sql 名 "dm" 下。
//
// 运维步骤
// --------
//
//   1. 把 gitee.com/chunanyong/dm 加入 vendor 或自建 module proxy
//      (e.g. internal Athens proxy)，或者直接 `go get` 让 GOPROXY
//      拉到本地缓存。
//   2. go build -tags dm_driver -o jumpserver ./cmd/jumpserver
//   3. 启动后 internal/dbquery/adapter_dameng.go 的 damengDriver.Open
//      会找到注册好的 "dm" 名，连接成功；否则它仍然返回带提示语的错误，
//      DB Studio 顶部 capability badge 仍然显示 "达梦 DM8" 但实际查询
//      会失败 — 这就是 register-without-driver 的"协议占位"模式。
//
// 我们故意不直接写 `_ "gitee.com/chunanyong/dm"` 而绕一层，这样默认
// build 不会因为 GOPROXY 抓不到 gitee 而整个失败。CI 跑 `go build` 不
// 加 tag 时此文件不参与编译，整个仓库可以离线构建。
//
//go:build dm_driver
// +build dm_driver

package main

// 这里是 operator 自行加的副导入。例：
//   import _ "gitee.com/chunanyong/dm"
//
// 留空也合法 — 表示 operator 在另一处文件里完成的导入注册。
