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
// Codes are verified against the installed FreeRDP 3.x include/freerdp/error.h
// (note that freerdp_get_last_error OR's the ERROR_CLASS_CONNECT constant
// 0x00020000 in, so the runtime code is e.g. 0x00020014 not 0x14):
//
//	0x00020001 PRE_CONNECT_FAILED
//	0x00020002 CONNECT_UNDEFINED
//	0x00020003 POST_CONNECT_FAILED
//	0x00020004 DNS_ERROR
//	0x00020005 DNS_NAME_NOT_FOUND
//	0x00020006 CONNECT_FAILED
//	0x00020007 MCS_CONNECT_INITIAL_ERROR
//	0x00020008 TLS_CONNECT_FAILED
//	0x00020009 AUTHENTICATION_FAILED
//	0x0002000A INSUFFICIENT_PRIVILEGES
//	0x0002000B CONNECT_CANCELLED
//	0x0002000C SECURITY_NEGO_CONNECT_FAILED
//	0x0002000D CONNECT_TRANSPORT_FAILED
//	0x0002000E PASSWORD_EXPIRED
//	0x0002000F PASSWORD_CERTAINLY_EXPIRED
//	0x00020010 CLIENT_REVOKED
//	0x00020011 KDC_UNREACHABLE
//	0x00020012 ACCOUNT_DISABLED
//	0x00020013 PASSWORD_MUST_CHANGE
//	0x00020014 LOGON_FAILURE
//	0x00020015 WRONG_PASSWORD
//	0x00020016 ACCESS_DENIED
//	0x00020017 ACCOUNT_RESTRICTION
//	0x00020018 ACCOUNT_LOCKED_OUT
//	0x00020019 ACCOUNT_EXPIRED
//	0x0002001A LOGON_TYPE_NOT_GRANTED
//	0x0002001B NO_OR_MISSING_CREDENTIALS
//	0x0002001C ACTIVATION_TIMEOUT
//	0x0002001D TARGET_BOOTING
//
// Previous revisions of this map were off-by-N for codes ≥ 0x00020010 —
// for example 0x00020014 was labeled "ACCOUNT_DISABLED" when it actually
// means LOGON_FAILURE (generic logon refusal, usually wrong creds).
// Operators reading the old error message got the wrong remediation
// advice. Mappings below were re-verified against the local FreeRDP
// install's error.h.
func humanizeConnectError(code uint32, raw string) string {
	var prefix string
	switch code {
	case 0x00020001:
		prefix = "预连接阶段失败:libfreerdp 初始化错误"
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
	case 0x00020009:
		prefix = "NLA/CredSSP 身份验证失败:用户名、密码或域名错误。请核对凭据"
	case 0x0002000A:
		prefix = "权限不足:当前账户没有远程登录权限。请在远端 Windows 上把账户加入 Remote Desktop Users 组"
	case 0x0002000B:
		prefix = "连接被取消(用户主动断或超时)"
	case 0x0002000C:
		prefix = "安全协商失败:服务器拒绝了我们提供的 RDP 安全协议组合。结合协商详情判断:服务器选择 RDP=只接 legacy RDP Security、HYBRID/NLA=凭据错、TLS=拒 NLA"
	case 0x0002000D:
		prefix = "传输层连接失败:TLS 握手已完成但 RDP 上层协议读超时。常见原因是凭据触发 CredSSP 失败,或 RDP capability 集错配"
	case 0x0002000E:
		prefix = "密码已过期:需要先去 Windows 修改密码再连"
	case 0x0002000F:
		prefix = "密码已确认过期:Windows 不接受任何登录,必须先在物理控制台改密码"
	case 0x00020010:
		prefix = "客户端证书被吊销:NLA 使用的 CredSSP 证书已被 CA 撤销"
	case 0x00020011:
		prefix = "KDC 不可达:Kerberos 域控制器不响应,常见于跨网段 + 防火墙阻断"
	case 0x00020012:
		prefix = "账户已禁用:在 AD / 本地用户管理里被禁用,需要先启用"
	case 0x00020013:
		prefix = "登录后强制修改密码:Windows 要求改密码,本客户端不支持远程改密"
	case 0x00020014:
		prefix = "登录失败:用户名或密码错误。请核对节点凭据;若用户名带域名(DOMAIN\\user),试试只填用户名 + 单独填域字段"
	case 0x00020015:
		prefix = "密码错误:用户名存在但密码不对"
	case 0x00020016:
		prefix = "访问被拒:账户存在但无法登录此远端。检查远端组策略 / Allow log on through Remote Desktop Services"
	case 0x00020017:
		prefix = "账户使用受限:工作站限制 / 工作时间限制阻止了登录"
	case 0x00020018:
		prefix = "账户已锁定:多次密码错误触发了锁定策略,需要管理员解锁"
	case 0x00020019:
		prefix = "账户已过期:AD 账户超出有效期"
	case 0x0002001A:
		prefix = "登录类型未授权:远端策略禁止 RemoteInteractiveLogon"
	case 0x0002001B:
		prefix = "凭据缺失:服务器要求 NLA 但客户端未提供有效凭据。补充节点凭据后重试"
	case 0x0002001C:
		prefix = "会话激活超时:连上后远端没在合理时间内完成会话初始化"
	case 0x0002001D:
		prefix = "目标正在启动:Windows 还没开机完成,稍后重试"
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

func selectedProtocolMaskString(mask uint32, rejected bool) string {
	if rejected && mask == 0 {
		return "rejected-all"
	}
	return protocolMaskString(mask)
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
		rejected := code == 0x0002000C && selected == 0
		base += fmt.Sprintf(" [协商详情] 本地请求: %s; 服务器选择: %s",
			protocolMaskString(requested), selectedProtocolMaskString(selected, rejected))
	}
	return base
}
