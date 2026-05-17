package notify

import "fmt"

// MFACodeMessage builds the email body for the OTP login factor.
func MFACodeMessage(to, code string, ttlMinutes int) Message {
	subject := fmt.Sprintf("[JumpServer] 登录验证码 %s", code)
	text := fmt.Sprintf("您正在登录 JumpServer，本次验证码：%s\n\n%d 分钟内有效。如果不是您本人操作，请忽略本邮件并立即修改密码。", code, ttlMinutes)
	html := fmt.Sprintf(`<p>您正在登录 <b>JumpServer</b>，本次验证码：</p>
<p style="font-size:28px;letter-spacing:6px;font-weight:bold;background:#f5f5f5;padding:12px 24px;display:inline-block;">%s</p>
<p>%d 分钟内有效。如果不是您本人操作，请忽略本邮件并立即修改密码。</p>`, code, ttlMinutes)
	return Message{To: []string{to}, Subject: subject, HTML: html, Text: text}
}

// AnomalyLoginMessage notifies a user of a successful login from an unusual location.
func AnomalyLoginMessage(to, username, ip, ua, country string) Message {
	subject := "[JumpServer] 检测到新的登录"
	text := fmt.Sprintf("账号 %s 在新位置/设备登录成功。\nIP: %s\n位置: %s\nUA: %s\n\n如果不是您本人，请立即修改密码并重置 MFA。",
		username, ip, country, ua)
	html := fmt.Sprintf(`<p>账号 <b>%s</b> 在新位置或新设备上登录成功：</p>
<ul><li>IP：%s</li><li>位置：%s</li><li>客户端：%s</li></ul>
<p>如果不是您本人，请立即<b>修改密码</b>并重置 MFA。</p>`, username, ip, country, ua)
	return Message{To: []string{to}, Subject: subject, HTML: html, Text: text}
}

// AccountLockedMessage informs the user their account is temporarily locked.
func AccountLockedMessage(to, username string, minutes int) Message {
	subject := "[JumpServer] 账号已被临时锁定"
	text := fmt.Sprintf("账号 %s 因多次登录失败已被临时锁定 %d 分钟。\n如果不是您本人操作，请检查密码是否已泄露。", username, minutes)
	return Message{To: []string{to}, Subject: subject, Text: text, HTML: text}
}
