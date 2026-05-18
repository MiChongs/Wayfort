//go:build freerdp

package rdp

import (
	"fmt"
	"strings"
)

// humanizeConnectError turns FreeRDP's ERRCONNECT_* numeric codes into
// operator-readable Chinese messages. The raw libfreerdp string is
// appended so the final message reads "Chinese hint (libfreerdp: raw)".
//
// Codes mirror include/freerdp/error.h (FreeRDP 3.x):
//
//	0x00020001 PRE_CONNECT_FAILED              libfreerdp init
//	0x00020002 CONNECT_UNDEFINED                generic
//	0x00020003 POST_CONNECT_FAILED              GDI / channel init
//	0x00020004 DNS_ERROR                        resolver lookup error
//	0x00020005 DNS_NAME_NOT_FOUND               unknown host
//	0x00020006 CONNECT_FAILED                   TCP connect failed
//	0x00020007 MCS_CONNECT_INITIAL_ERROR        MCS PDU rejected
//	0x00020008 TLS_CONNECT_FAILED               TLS handshake refused
//	0x00020009 AUTHENTICATION_FAILED            NLA / CredSSP rejected creds
//	0x0002000A INSUFFICIENT_PRIVILEGES          operator can't elevate
//	0x0002000B CONNECT_CANCELLED                user / timeout cancel
//	0x0002000C SECURITY_NEGO_CONNECT_FAILED     X.224 negotiation rejected
//	0x0002000D CONNECT_TRANSPORT_FAILED         transport stalled mid-handshake
//	0x0002000E PASSWORD_EXPIRED                 AD password is expired
//	0x0002000F PASSWORD_MUST_CHANGE             must change at next logon
//	0x00020010 LOGON_FAILURE                    generic logon refusal
//	0x00020011 WRONG_PASSWORD                   correct user, wrong pw
//	0x00020012 ACCESS_DENIED                    account not allowed RDP
//	0x00020013 ACCOUNT_RESTRICTION              time-of-day / workstation
//	0x00020014 ACCOUNT_DISABLED                 user disabled in AD
//	0x00020015 ACCOUNT_EXPIRED                  user account expired
//	0x00020016 LOGON_TYPE_NOT_GRANTED           RemoteInteractiveLogon denied
//	0x00020017 NO_OR_MISSING_CREDENTIALS        empty creds with NLA enabled
func humanizeConnectError(code uint32, raw string) string {
	var prefix string
	switch code {
	case 0x00020001:
		prefix = "预连接阶段失败:libfreerdp 初始化错误。重启网关 + 重建 worker 二进制再试"
	case 0x00020003:
		prefix = "后连接阶段失败:RDP 通道 / GDI 初始化错误。可能远端图形协议跟客户端能力集错配"
	case 0x00020004, 0x00020005:
		prefix = "域名解析失败:目标主机名无法解析,检查节点 host 配置"
	case 0x00020006:
		prefix = "无法建立 TCP 连接:目标地址不可达,检查节点 host/port、代理链、防火墙"
	case 0x00020007:
		prefix = "MCS 协商失败:RDP 协议层 PDU 被远端拒,通常远端 RDP 服务异常或版本过旧"
	case 0x00020008:
		prefix = "TLS 握手失败:远端不支持 TLS 或本地 OpenSSL 屏蔽了远端要求的 TLS 版本。试着在节点 RDP 设置里把 TLS 安全级别降到 0"
	case 0x00020009, 0x00020010:
		prefix = "身份验证失败 (NLA/CredSSP):用户名、密码或域名错误。请核对凭据;若节点不强制 NLA,试着把安全模式改为 TLS"
	case 0x0002000A:
		prefix = "权限不足:当前账户没有远程登录权限。请在远端 Windows 上把账户加入 Remote Desktop Users 组"
	case 0x0002000B:
		prefix = "连接被取消(用户主动断或超时)"
	case 0x0002000C:
		prefix = "安全协商失败:服务器拒绝了我们提供的所有 RDP 安全协议(NLA / TLS / RDP / NLA-EX)。" +
			"远端可能要求 NLA-EX 但本地未启用,或要求 RDP Security 但默认禁用。试在节点 RDP 设置里把安全模式改成 'tls' / 'rdp' 各试一次"
	case 0x0002000D:
		prefix = "传输层连接失败:TLS 握手已完成但 RDP 上层协议读超时。常见原因是凭据触发 CredSSP 失败,或 RDP capability 集错配。试着把安全模式改成 'tls'"
	case 0x0002000E:
		prefix = "密码已过期:需要先去 Windows 修改密码再连"
	case 0x0002000F:
		prefix = "登录后强制修改密码:本客户端不支持远程改密,请在物理控制台先改"
	case 0x00020011:
		prefix = "密码错误:用户名存在但密码不对"
	case 0x00020012:
		prefix = "访问被拒:账户存在但无法登录此远端。检查远端组策略 / Allow log on through Remote Desktop Services"
	case 0x00020013:
		prefix = "账户使用受限:工作站限制 / 工作时间限制阻止了登录"
	case 0x00020014:
		prefix = "账户已禁用:在 AD / 本地用户管理里被禁用,需要先启用"
	case 0x00020015:
		prefix = "账户已过期:AD 账户超出有效期"
	case 0x00020016:
		prefix = "登录类型未授权:远端策略禁止 RemoteInteractiveLogon"
	case 0x00020017:
		prefix = "凭据缺失:服务器要求 NLA 但客户端未提供有效凭据。补充节点凭据后重试"
	default:
		if raw != "" {
			return raw
		}
		return "未知连接错误"
	}
	tail := strings.TrimSpace(raw)
	if tail == "" || strings.EqualFold(tail, prefix) {
		return prefix
	}
	return prefix + " (libfreerdp: " + tail + ")"
}

// protocolMaskString renders an X.224 protocol bitfield as a human-
// readable list. Bits are defined in [MS-RDPBCGR] §2.2.1.1.1 and
// FreeRDP_RequestedProtocols / FreeRDP_SelectedProtocol use them:
//
//	0x01 PROTOCOL_SSL       (TLS)
//	0x02 PROTOCOL_HYBRID    (NLA / CredSSP)
//	0x04 PROTOCOL_RDSTLS    (RDS Gateway TLS)
//	0x08 PROTOCOL_HYBRID_EX (NLA-EX, Windows 10+)
//	0x10 PROTOCOL_RDSAAD    (Microsoft Entra ID, FreeRDP 3.x)
//
// mask == 0 means "legacy RDP encryption" (PROTOCOL_RDP); for the
// SelectedProtocol field it also means the server rejected every offered
// modern protocol.
func protocolMaskString(mask uint32) string {
	if mask == 0 {
		return "RDP"
	}
	parts := make([]string, 0, 5)
	if mask&0x01 != 0 {
		parts = append(parts, "TLS")
	}
	if mask&0x02 != 0 {
		parts = append(parts, "HYBRID/NLA")
	}
	if mask&0x04 != 0 {
		parts = append(parts, "RDSTLS")
	}
	if mask&0x08 != 0 {
		parts = append(parts, "HYBRID_EX/NLA-EX")
	}
	if mask&0x10 != 0 {
		parts = append(parts, "RDSAAD")
	}
	if len(parts) == 0 {
		return fmt.Sprintf("0x%X", mask)
	}
	return strings.Join(parts, "+")
}

// humanizeConnectErrorWithNego is humanizeConnectError plus an "[协商详情]"
// suffix when the error class implies X.224 negotiation was involved
// (SECURITY_NEGO / CONNECT_TRANSPORT). The two extra bitfields turn a
// rejection like 0x0002000C from "服务器拒绝了所有协议" into
// "服务器拒绝了所有协议; 本地请求 TLS+HYBRID/NLA+...; 服务器选择 RDP",
// which immediately tells the operator whether to switch security mode
// (server picked legacy RDP) or to check credentials (server picked NLA
// but CredSSP died).
func humanizeConnectErrorWithNego(code uint32, raw string, requested, selected uint32) string {
	base := humanizeConnectError(code, raw)
	if code == 0x0002000C || code == 0x0002000D {
		base += fmt.Sprintf(" [协商详情] 本地请求: %s; 服务器选择: %s",
			protocolMaskString(requested), protocolMaskString(selected))
	}
	return base
}
