// Guacamole protocol status-code translations.
//
// guacd surfaces failures by sending a `4.error,<code>.<value>,<n>.<message>;`
// instruction on the wire. The codes are documented at
// https://guacamole.apache.org/doc/gug/protocol-reference.html#status-codes
//
// We translate the codes most commonly seen during RDP / VNC sessions to a
// short Chinese title so audit log entries are human-readable without having
// to look up hex codes. Plan 13.A.2.
package guacamole

import "fmt"

// guacErrorMessages maps Guacamole status codes to a short Chinese label.
// Codes not in this table get formatted as "未知错误 (code=0xNNNN)".
var guacErrorMessages = map[int]string{
	0x0000: "成功",
	0x0100: "服务器内部错误",
	0x0101: "操作不受支持",
	0x0200: "服务器资源不足",
	0x0201: "服务器已达最大连接数",
	0x0202: "请求的资源已被占用",
	0x0203: "请求的资源忙",
	0x0204: "请求的资源不可用",
	0x0205: "服务器超时",
	0x0207: "目标主机不可达",
	0x0208: "目标主机超时",
	0x0209: "目标连接被中断",
	0x020A: "目标连接被关闭",
	0x020B: "目标 SSL/TLS 握手失败",
	0x020D: "客户端连接被中断",
	0x020E: "客户端连接超时",
	0x0300: "请求格式错误",
	0x0301: "未认证 / 凭据错误",
	0x0303: "拒绝访问",
	0x0308: "客户端请求超时",
	0x031D: "客户端禁用此功能",
}

// Describe returns a short Chinese label for the given Guacamole status code.
// Unknown codes get a generic formatted fallback so audit consumers never
// see a bare hex blob.
func Describe(code int) string {
	if m, ok := guacErrorMessages[code]; ok {
		return m
	}
	return fmt.Sprintf("未知错误 (code=0x%04X)", code)
}
