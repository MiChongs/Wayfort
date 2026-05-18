//go:build freerdp

package rdp

import "strings"

// humanizeConnectError turns FreeRDP's ERRCONNECT_* numeric codes into
// operator-readable Chinese messages. The raw error string from
// freerdp_get_last_error_string is appended for diagnostics — the
// humanized prefix tells the operator what *kind* of failure happened
// (and what their next move is), the raw tail tells them which specific
// libfreerdp branch tripped.
//
// Codes are from include/freerdp/error.h:
//   0x0002000C  ERRCONNECT_CONNECT_TRANSPORT_FAILED
//   0x0002000D  ERRCONNECT_CONNECT_UNDEFINED (TLS/NLA negotiation died)
//   0x00020005  ERRCONNECT_AUTHENTICATION_FAILED
//   0x00020009  ERRCONNECT_CONNECT_CANCELLED / refused
//   0x00020014  ERRCONNECT_SERVER_DENIED_CONNECTION
//   0x00020001  ERRCONNECT_PRE_CONNECT_FAILED
//   0x00020012  ERRCONNECT_DNS_NAME_NOT_FOUND
//   0x00020013  ERRCONNECT_CONNECT_FAILED
func humanizeConnectError(code uint32, raw string) string {
	var prefix string
	switch code {
	case 0x0002000D:
		prefix = "TLS/NLA 协商失败:远端可能禁用 NLA、要求更高 TLS 版本,或凭据被拒。若节点是老 Windows Server,在节点设置里关掉 NLA 再试"
	case 0x0002000C:
		prefix = "传输层连接失败:TLS 握手未完成。常见原因:远端只支持 RDP Security、TLS 1.0 已被本地 OpenSSL 屏蔽、或证书已过期"
	case 0x00020005:
		prefix = "身份验证失败:用户名、密码或域名错误。请核对节点凭据"
	case 0x00020009:
		prefix = "连接被远端拒绝:检查目标 RDP 服务是否启动、端口是否监听、防火墙是否放行"
	case 0x00020014:
		prefix = "服务器拒绝连接:可能 RDP 会话数已满或终端服务许可证已过期"
	case 0x00020012:
		prefix = "域名解析失败:目标主机名无法解析"
	case 0x00020013:
		prefix = "无法建立 TCP 连接:目标地址不可达,检查节点配置和网络链路"
	case 0x00020001:
		prefix = "预连接阶段失败:libfreerdp 内部初始化错误"
	default:
		// Unknown code — surface the raw libfreerdp string as-is. Operator
		// can search "freerdp errconnect <code>" online if needed.
		if raw != "" {
			return raw
		}
		return "未知连接错误"
	}
	// Strip the duplicated "ERRCONNECT_*" token from the raw tail so the
	// final message reads naturally.
	tail := strings.TrimSpace(raw)
	if tail == "" || strings.EqualFold(tail, prefix) {
		return prefix
	}
	return prefix + " (libfreerdp: " + tail + ")"
}
