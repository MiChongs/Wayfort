package approval

import (
	"bytes"
	"context"
	"crypto/hmac"
	"crypto/sha256"
	"encoding/base64"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"strconv"
	"strings"
	"time"

	"github.com/michongs/wayfort/internal/model"
)

// IM card notifiers share a small set of helpers so each channel-specific
// file only carries its card-schema code and (optionally) a per-channel
// signing scheme. The Notifier interface in notifier.go is what the
// FanoutNotifier dispatches against; each *Notifier struct below
// implements Kind() + Notify().
//
// Channels implemented in this file:
//
//   feishu     — Lark / 飞书 webhook (interactive card)
//   dingtalk   — DingTalk / 钉钉 robot (actionCard + HMAC signed URL)
//   wecom      — WeCom / 企业微信 group robot (markdown)
//   slack      — Slack incoming webhook (Block Kit)
//   teams      — MS Teams Incoming Webhook (MessageCard)
//
// Each implementation accepts the same NotifyEnvelope and renders a card
// that surfaces: who requested, what business action, the resource, the
// computed risk level, and (for pending events) clickable buttons routed
// at the gateway's /api/v1/approvals/tasks/:id/approve|reject endpoints.
// The buttons carry the request ID — approvers tap them in their IM
// client, which fires an HTTP request signed by the IM platform back at
// the gateway. Wiring the callback receiver lives in a separate handler
// (next phase); the cards themselves are useful immediately as a
// "you have an approval to review" prompt.

// --- shared helpers ---------------------------------------------------------

// sharedHTTP is the HTTP client every IM notifier uses. Reasonable timeout
// because IM platforms occasionally serve from saturated regional edges;
// the bounded queue inside FanoutNotifier handles back-pressure.
var sharedHTTP = &http.Client{Timeout: 8 * time.Second}

// postJSON serialises the payload and POSTs it to the supplied URL. The
// optional headers map lets channel-specific code add Authorization /
// signing headers without duplicating boilerplate. Returns the response
// body for callers that need to inspect it (DingTalk surfaces errors in
// the response body even on HTTP 200).
func postJSON(ctx context.Context, url string, payload any, headers map[string]string) ([]byte, error) {
	body, err := json.Marshal(payload)
	if err != nil {
		return nil, err
	}
	req, err := http.NewRequestWithContext(ctx, http.MethodPost, url, bytes.NewReader(body))
	if err != nil {
		return nil, err
	}
	req.Header.Set("Content-Type", "application/json; charset=utf-8")
	for k, v := range headers {
		req.Header.Set(k, v)
	}
	resp, err := sharedHTTP.Do(req)
	if err != nil {
		return nil, err
	}
	defer func() { _, _ = io.Copy(io.Discard, resp.Body); _ = resp.Body.Close() }()
	if resp.StatusCode/100 != 2 {
		// Read up to 1 KiB of the error body so the audit trail captures
		// the platform's complaint instead of just "HTTP 500".
		buf := make([]byte, 1024)
		n, _ := resp.Body.Read(buf)
		return buf[:n], fmt.Errorf("%s returned HTTP %d: %s", url, resp.StatusCode, string(buf[:n]))
	}
	out, _ := io.ReadAll(resp.Body)
	return out, nil
}

// riskColor returns the canonical channel-neutral colour band for a risk
// level. Feishu / Slack / Teams all consume this differently — see each
// notifier — but the input table stays consistent.
func riskColor(level model.ApprovalRiskLevel) string {
	switch level {
	case model.ApprovalRiskCritical:
		return "red"
	case model.ApprovalRiskHigh:
		return "orange"
	case model.ApprovalRiskMedium:
		return "blue"
	}
	return "grey"
}

// summaryFor renders a single-line human description of the event. Used
// as the card title on every channel. Chinese-leaning per the project's
// existing UI conventions; runs through every business type in the goal.
func summaryFor(env NotifyEnvelope) string {
	switch env.Event.Kind {
	case model.ApprovalEvRequestCreated:
		return fmt.Sprintf("待审批：%s 申请 %s", env.Request.RequesterName, bizLabel(env.Request.BusinessType))
	case model.ApprovalEvAutoApproved, model.ApprovalEvRequestApproved:
		return fmt.Sprintf("已通过：%s 的 %s 申请", env.Request.RequesterName, bizLabel(env.Request.BusinessType))
	case model.ApprovalEvRequestRejected:
		return fmt.Sprintf("已驳回：%s 的 %s 申请", env.Request.RequesterName, bizLabel(env.Request.BusinessType))
	case model.ApprovalEvRequestExpired:
		return fmt.Sprintf("已过期：%s 的 %s 申请", env.Request.RequesterName, bizLabel(env.Request.BusinessType))
	case model.ApprovalEvRequestCancelled:
		return fmt.Sprintf("已撤销：%s 的 %s 申请", env.Request.RequesterName, bizLabel(env.Request.BusinessType))
	case model.ApprovalEvGrantIssued:
		return fmt.Sprintf("已发放 Grant：%s — %s", env.Request.RequesterName, bizLabel(env.Request.BusinessType))
	case model.ApprovalEvGrantRevoked:
		return fmt.Sprintf("Grant 已吊销：%s — %s", env.Request.RequesterName, bizLabel(env.Request.BusinessType))
	case model.ApprovalEvTaskCreated:
		return fmt.Sprintf("待审批任务：%s 申请 %s", env.Request.RequesterName, bizLabel(env.Request.BusinessType))
	}
	return string(env.Event.Kind)
}

func bizLabel(b model.ApprovalBusinessType) string {
	switch b {
	case model.ApprovalBizAssetAccess:
		return "资产访问"
	case model.ApprovalBizCredentialUse:
		return "凭据使用"
	case model.ApprovalBizCommandExec:
		return "命令执行"
	case model.ApprovalBizSQLExec:
		return "SQL 执行"
	case model.ApprovalBizFileTransfer:
		return "文件传输"
	case model.ApprovalBizSessionExtend:
		return "会话续期"
	case model.ApprovalBizSessionElevate:
		return "会话提权"
	case model.ApprovalBizBreakGlass:
		return "应急访问"
	case model.ApprovalBizVendorAccess:
		return "第三方厂商访问"
	case model.ApprovalBizAuditView:
		return "审计查看"
	}
	return string(b)
}

func riskLabel(l model.ApprovalRiskLevel) string {
	switch l {
	case model.ApprovalRiskCritical:
		return "🔥 严重"
	case model.ApprovalRiskHigh:
		return "⚠ 高危"
	case model.ApprovalRiskMedium:
		return "⚡ 中"
	}
	return "ℹ 低"
}

// --- Feishu / Lark ----------------------------------------------------------

// FeishuNotifier posts an interactive card to a Lark / Feishu group bot
// webhook. The optional Secret column on the Subscription row is used as
// the HMAC signing key (set the same value on the bot's "签名校验" toggle).
type FeishuNotifier struct{}

func (*FeishuNotifier) Kind() string { return "feishu" }

func (n *FeishuNotifier) Notify(ctx context.Context, env NotifyEnvelope) error {
	if env.Subscription.Target == "" {
		return fmt.Errorf("feishu: webhook url required")
	}
	card := feishuCardFor(env)
	payload := map[string]any{
		"msg_type": "interactive",
		"card":     card,
	}
	// Sign: HMAC(secret, timestamp + "\n" + secret) → base64. Lark wants
	// `timestamp` and `sign` as TOP-LEVEL fields, not inside the card.
	if env.Subscription.Secret != "" {
		ts := strconv.FormatInt(time.Now().Unix(), 10)
		signTarget := ts + "\n" + env.Subscription.Secret
		mac := hmac.New(sha256.New, []byte(signTarget))
		mac.Write(nil)
		sig := base64.StdEncoding.EncodeToString(mac.Sum(nil))
		payload["timestamp"] = ts
		payload["sign"] = sig
	}
	resp, err := postJSON(ctx, env.Subscription.Target, payload, nil)
	if err != nil {
		return err
	}
	// Lark returns {"code":0,"msg":"success"} on success; non-zero code
	// surfaces in the body even on HTTP 200.
	var rb struct{ Code int `json:"code"`; Msg string `json:"msg"` }
	if json.Unmarshal(resp, &rb) == nil && rb.Code != 0 {
		return fmt.Errorf("feishu: code=%d msg=%s", rb.Code, rb.Msg)
	}
	return nil
}

func feishuCardFor(env NotifyEnvelope) map[string]any {
	template := "blue"
	switch env.Request.RiskLevel {
	case model.ApprovalRiskCritical:
		template = "red"
	case model.ApprovalRiskHigh:
		template = "orange"
	case model.ApprovalRiskMedium:
		template = "blue"
	default:
		template = "grey"
	}
	elements := []map[string]any{
		{
			"tag": "div",
			"text": map[string]any{
				"tag":     "lark_md",
				"content": fmt.Sprintf("**业务**：%s\n**风险**：%s\n**资源**：%s\n**理由**：%s",
					bizLabel(env.Request.BusinessType),
					riskLabel(env.Request.RiskLevel),
					env.Request.ResourceType+":"+env.Request.ResourceID,
					env.Request.Reason),
			},
		},
	}
	// Only show action buttons for live requests. Closed events get a
	// status pill but no buttons.
	if env.Event.Kind == model.ApprovalEvRequestCreated ||
		env.Event.Kind == model.ApprovalEvTaskCreated {
		elements = append(elements, map[string]any{
			"tag": "action",
			"actions": []map[string]any{
				{"tag": "button", "type": "primary",
					"text":  map[string]any{"tag": "plain_text", "content": "批准"},
					"value": map[string]any{"action": "approve", "request_id": env.Request.ID}},
				{"tag": "button", "type": "danger",
					"text":  map[string]any{"tag": "plain_text", "content": "驳回"},
					"value": map[string]any{"action": "reject", "request_id": env.Request.ID}},
			},
		})
	}
	return map[string]any{
		"config": map[string]any{"wide_screen_mode": true},
		"header": map[string]any{
			"template": template,
			"title":    map[string]any{"tag": "plain_text", "content": summaryFor(env)},
		},
		"elements": elements,
	}
}

// --- DingTalk ---------------------------------------------------------------

// DingTalkNotifier posts an actionCard. The official robot endpoint
// supports HMAC-SHA256 over `timestamp + "\n" + secret` returned as
// base64+urlencoded and appended to the URL as `timestamp=&sign=` query
// params (different from Lark which puts sign in the body).
type DingTalkNotifier struct{}

func (*DingTalkNotifier) Kind() string { return "dingtalk" }

func (n *DingTalkNotifier) Notify(ctx context.Context, env NotifyEnvelope) error {
	if env.Subscription.Target == "" {
		return fmt.Errorf("dingtalk: webhook url required")
	}
	url := env.Subscription.Target
	if env.Subscription.Secret != "" {
		ts := strconv.FormatInt(time.Now().UnixMilli(), 10)
		stringToSign := ts + "\n" + env.Subscription.Secret
		mac := hmac.New(sha256.New, []byte(env.Subscription.Secret))
		mac.Write([]byte(stringToSign))
		sig := base64.StdEncoding.EncodeToString(mac.Sum(nil))
		sep := "?"
		if strings.Contains(url, "?") {
			sep = "&"
		}
		url = url + sep + "timestamp=" + ts + "&sign=" + httpEscape(sig)
	}
	payload := dingTalkActionCard(env)
	resp, err := postJSON(ctx, url, payload, nil)
	if err != nil {
		return err
	}
	var rb struct{ ErrCode int `json:"errcode"`; ErrMsg string `json:"errmsg"` }
	if json.Unmarshal(resp, &rb) == nil && rb.ErrCode != 0 {
		return fmt.Errorf("dingtalk: errcode=%d errmsg=%s", rb.ErrCode, rb.ErrMsg)
	}
	return nil
}

func dingTalkActionCard(env NotifyEnvelope) map[string]any {
	md := fmt.Sprintf("### %s\n\n- **业务**：%s\n- **风险**：%s\n- **资源**：`%s`\n- **理由**：%s",
		summaryFor(env),
		bizLabel(env.Request.BusinessType),
		riskLabel(env.Request.RiskLevel),
		env.Request.ResourceType+":"+env.Request.ResourceID,
		env.Request.Reason)
	card := map[string]any{
		"title":      summaryFor(env),
		"text":       md,
		"hideAvatar": "0",
		"btnOrientation": "0",
	}
	if env.Event.Kind == model.ApprovalEvRequestCreated ||
		env.Event.Kind == model.ApprovalEvTaskCreated {
		card["btns"] = []map[string]any{
			{"title": "批准", "actionURL": "dingtalk://wayfort/approve/" + env.Request.ID},
			{"title": "驳回", "actionURL": "dingtalk://wayfort/reject/" + env.Request.ID},
		}
	} else {
		card["singleTitle"] = "查看详情"
		card["singleURL"] = "dingtalk://wayfort/view/" + env.Request.ID
	}
	return map[string]any{
		"msgtype":    "actionCard",
		"actionCard": card,
	}
}

// --- WeCom (企业微信) ------------------------------------------------------

// WeComNotifier posts a markdown message to a WeCom group robot. WeCom
// robots don't support per-message signing; URL secrecy is the only
// authentication factor.
type WeComNotifier struct{}

func (*WeComNotifier) Kind() string { return "wecom" }

func (n *WeComNotifier) Notify(ctx context.Context, env NotifyEnvelope) error {
	if env.Subscription.Target == "" {
		return fmt.Errorf("wecom: webhook url required")
	}
	md := fmt.Sprintf("**%s**\n>业务：<font color=\"info\">%s</font>\n>风险：%s\n>资源：`%s`\n>理由：%s",
		summaryFor(env),
		bizLabel(env.Request.BusinessType),
		riskLabel(env.Request.RiskLevel),
		env.Request.ResourceType+":"+env.Request.ResourceID,
		env.Request.Reason)
	payload := map[string]any{
		"msgtype":  "markdown",
		"markdown": map[string]string{"content": md},
	}
	resp, err := postJSON(ctx, env.Subscription.Target, payload, nil)
	if err != nil {
		return err
	}
	var rb struct{ ErrCode int `json:"errcode"`; ErrMsg string `json:"errmsg"` }
	if json.Unmarshal(resp, &rb) == nil && rb.ErrCode != 0 {
		return fmt.Errorf("wecom: errcode=%d errmsg=%s", rb.ErrCode, rb.ErrMsg)
	}
	return nil
}

// --- Slack ------------------------------------------------------------------

// SlackNotifier posts a Block Kit message to an Incoming Webhook URL.
// Slack incoming webhooks don't support signing; URL secrecy is the
// only authentication. For workflows that need per-message signing,
// switch to the Slack Bot API in a later phase.
type SlackNotifier struct{}

func (*SlackNotifier) Kind() string { return "slack" }

func (n *SlackNotifier) Notify(ctx context.Context, env NotifyEnvelope) error {
	if env.Subscription.Target == "" {
		return fmt.Errorf("slack: webhook url required")
	}
	payload := slackBlockKit(env)
	_, err := postJSON(ctx, env.Subscription.Target, payload, nil)
	return err
}

func slackBlockKit(env NotifyEnvelope) map[string]any {
	blocks := []map[string]any{
		{
			"type": "header",
			"text": map[string]any{"type": "plain_text", "text": summaryFor(env)},
		},
		{
			"type": "section",
			"fields": []map[string]any{
				{"type": "mrkdwn", "text": "*Business*\n" + bizLabel(env.Request.BusinessType)},
				{"type": "mrkdwn", "text": "*Risk*\n" + riskLabel(env.Request.RiskLevel)},
				{"type": "mrkdwn", "text": "*Resource*\n`" + env.Request.ResourceType + ":" + env.Request.ResourceID + "`"},
				{"type": "mrkdwn", "text": "*Requester*\n" + env.Request.RequesterName},
			},
		},
	}
	if env.Request.Reason != "" {
		blocks = append(blocks, map[string]any{
			"type": "section",
			"text": map[string]any{"type": "mrkdwn", "text": "*Reason*\n" + env.Request.Reason},
		})
	}
	if env.Event.Kind == model.ApprovalEvRequestCreated ||
		env.Event.Kind == model.ApprovalEvTaskCreated {
		blocks = append(blocks, map[string]any{
			"type": "actions",
			"elements": []map[string]any{
				{"type": "button", "style": "primary",
					"text": map[string]any{"type": "plain_text", "text": "Approve"},
					"value": "approve:" + env.Request.ID,
					"action_id": "approval_approve"},
				{"type": "button", "style": "danger",
					"text": map[string]any{"type": "plain_text", "text": "Reject"},
					"value": "reject:" + env.Request.ID,
					"action_id": "approval_reject"},
			},
		})
	}
	return map[string]any{"blocks": blocks, "text": summaryFor(env)}
}

// --- MS Teams ---------------------------------------------------------------

// TeamsNotifier posts a legacy MessageCard ("connector card") to an MS
// Teams Incoming Webhook. The newer Adaptive Card format requires Power
// Automate; MessageCard works against the simple connector URL that's
// most commonly deployed.
type TeamsNotifier struct{}

func (*TeamsNotifier) Kind() string { return "teams" }

func (n *TeamsNotifier) Notify(ctx context.Context, env NotifyEnvelope) error {
	if env.Subscription.Target == "" {
		return fmt.Errorf("teams: webhook url required")
	}
	themeColor := "0072C6"
	switch env.Request.RiskLevel {
	case model.ApprovalRiskCritical:
		themeColor = "B71C1C"
	case model.ApprovalRiskHigh:
		themeColor = "E65100"
	case model.ApprovalRiskMedium:
		themeColor = "0072C6"
	default:
		themeColor = "757575"
	}
	facts := []map[string]string{
		{"name": "Business", "value": bizLabel(env.Request.BusinessType)},
		{"name": "Risk", "value": riskLabel(env.Request.RiskLevel)},
		{"name": "Resource", "value": env.Request.ResourceType + ":" + env.Request.ResourceID},
		{"name": "Requester", "value": env.Request.RequesterName},
	}
	if env.Request.Reason != "" {
		facts = append(facts, map[string]string{"name": "Reason", "value": env.Request.Reason})
	}
	card := map[string]any{
		"@type":      "MessageCard",
		"@context":   "https://schema.org/extensions",
		"summary":    summaryFor(env),
		"themeColor": themeColor,
		"title":      summaryFor(env),
		"sections": []map[string]any{
			{"facts": facts, "markdown": true},
		},
	}
	if env.Event.Kind == model.ApprovalEvRequestCreated ||
		env.Event.Kind == model.ApprovalEvTaskCreated {
		card["potentialAction"] = []map[string]any{
			{
				"@type":  "OpenUri",
				"name":   "Approve",
				"targets": []map[string]string{{"os": "default", "uri": "https://wayfort/approvals/" + env.Request.ID + "/approve"}},
			},
			{
				"@type":  "OpenUri",
				"name":   "Reject",
				"targets": []map[string]string{{"os": "default", "uri": "https://wayfort/approvals/" + env.Request.ID + "/reject"}},
			},
		}
	}
	_, err := postJSON(ctx, env.Subscription.Target, card, nil)
	return err
}

// httpEscape is a minimal URL-escape for the DingTalk signature query
// parameter. We don't pull in net/url because we only need to escape
// base64 characters (`+`, `/`, `=`) that mess up query parsing.
func httpEscape(s string) string {
	var b strings.Builder
	for _, r := range s {
		switch r {
		case '+':
			b.WriteString("%2B")
		case '/':
			b.WriteString("%2F")
		case '=':
			b.WriteString("%3D")
		default:
			b.WriteRune(r)
		}
	}
	return b.String()
}
