package notifications

import (
	"fmt"
	"html"
	"strings"
	"time"
)

// AnomalyEmail builds the email body for an anomalous successful login. `where`
// is a pre-formatted location string (country / city / "内网"); `reasons` is the
// human-readable reason summary; `score` is the 0–100 risk score.
func AnomalyEmail(username, ip, where, reasons string, score int, when time.Time) (subject, htmlBody, text string) {
	subject = "[JumpServer] 检测到异常登录"
	ts := when.Format("2006-01-02 15:04:05")
	text = fmt.Sprintf(
		"账号 %s 发生了一次被判定为异常的登录。\n时间：%s\nIP：%s\n位置：%s\n风险评分：%d/100\n判定原因：%s\n\n如果这不是您本人操作，请立即修改密码并重置 MFA，并联系管理员。",
		username, ts, ip, where, score, reasons)
	htmlBody = fmt.Sprintf(`<p>账号 <b>%s</b> 发生了一次被判定为<b>异常</b>的登录：</p>
<ul>
  <li>时间：%s</li>
  <li>IP：%s</li>
  <li>位置：%s</li>
  <li>风险评分：<b>%d</b>/100</li>
  <li>判定原因：%s</li>
</ul>
<p>如果这不是您本人操作，请立即<b>修改密码</b>并重置 MFA，并联系管理员。</p>`,
		esc(username), esc(ts), esc(ip), esc(where), score, esc(reasons))
	return
}

// AnomalyAdminEmail is the security-team variant: same facts, framed as an alert
// about another user's account rather than "your" account.
func AnomalyAdminEmail(username, ip, where, reasons string, score int, when time.Time) (subject, htmlBody, text string) {
	subject = fmt.Sprintf("[JumpServer] 安全告警：账号 %s 异常登录", username)
	ts := when.Format("2006-01-02 15:04:05")
	text = fmt.Sprintf(
		"安全告警：账号 %s 发生了一次异常登录。\n时间：%s\nIP：%s\n位置：%s\n风险评分：%d/100\n判定原因：%s\n\n请在审计中心 → 安全告警 中核查。",
		username, ts, ip, where, score, reasons)
	htmlBody = fmt.Sprintf(`<p><b>安全告警</b>：账号 <b>%s</b> 发生了一次异常登录。</p>
<ul>
  <li>时间：%s</li>
  <li>IP：%s</li>
  <li>位置：%s</li>
  <li>风险评分：<b>%d</b>/100</li>
  <li>判定原因：%s</li>
</ul>
<p>请在审计中心 → 安全告警 中核查。</p>`,
		esc(username), esc(ts), esc(ip), esc(where), score, esc(reasons))
	return
}

// BruteForceEmail builds the security-team alert for a failed-attempt burst.
func BruteForceEmail(username, ip string, count int, window time.Duration) (subject, htmlBody, text string) {
	subject = fmt.Sprintf("[JumpServer] 安全告警：账号 %s 疑似暴力破解", username)
	w := humanizeDuration(window)
	text = fmt.Sprintf(
		"安全告警：账号 %s 在 %s 内出现 %d 次登录失败，疑似暴力破解 / 撞库。\n来源 IP：%s\n\n请确认是否需要封禁来源 IP 或强制该账号重置密码。",
		username, w, count, ip)
	htmlBody = fmt.Sprintf(`<p><b>安全告警</b>：账号 <b>%s</b> 在 %s 内出现 <b>%d</b> 次登录失败，疑似暴力破解 / 撞库。</p>
<ul><li>来源 IP：%s</li></ul>
<p>请确认是否需要封禁来源 IP 或强制该账号重置密码。</p>`,
		esc(username), esc(w), count, esc(ip))
	return
}

// AccountLockedEmail builds the user-facing lockout notice.
func AccountLockedEmail(username string, minutes int) (subject, htmlBody, text string) {
	subject = "[JumpServer] 账号已被临时锁定"
	text = fmt.Sprintf("账号 %s 因多次登录失败已被临时锁定 %d 分钟。\n如果不是您本人操作，请检查密码是否已泄露并尽快修改。", username, minutes)
	htmlBody = fmt.Sprintf(`<p>账号 <b>%s</b> 因多次登录失败已被临时锁定 <b>%d</b> 分钟。</p>
<p>如果不是您本人操作，请检查密码是否已泄露并尽快修改。</p>`, esc(username), minutes)
	return
}

func esc(s string) string { return html.EscapeString(s) }

// humanizeDuration renders a duration as a short Chinese string (分钟/小时).
func humanizeDuration(d time.Duration) string {
	if d <= 0 {
		return "—"
	}
	if d < time.Hour {
		return fmt.Sprintf("%d 分钟", int(d.Minutes()))
	}
	h := int(d.Hours())
	m := int(d.Minutes()) % 60
	if m == 0 {
		return fmt.Sprintf("%d 小时", h)
	}
	return fmt.Sprintf("%d 小时 %d 分钟", h, m)
}

// JoinReasons renders machine reason codes as a human-readable Chinese summary.
func JoinReasons(human []string) string {
	if len(human) == 0 {
		return "未知"
	}
	return strings.Join(human, "、")
}
