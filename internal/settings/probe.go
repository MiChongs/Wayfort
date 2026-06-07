package settings

import (
	"context"
	"crypto/tls"
	"fmt"
	"net"
	"net/http"
	"net/smtp"
	"net/url"
	"strings"
	"sync"
	"time"

	"github.com/michongs/jumpserver-anonymous/internal/config"
	"github.com/michongs/jumpserver-anonymous/internal/dockerx"
)

// IntegrationState is the connectivity state machine surfaced per external
// dependency. The UI renders each as a coloured chip and drives transitions
// with the 测试 button.
//
//	disabled     ── feature toggle off
//	unconfigured ── on, but required fields are blank
//	configured   ── filled in, not verified this run
//	healthy      ── last live probe succeeded
//	error        ── last live probe failed
type IntegrationState string

const (
	StateDisabled     IntegrationState = "disabled"
	StateUnconfigured IntegrationState = "unconfigured"
	StateConfigured   IntegrationState = "configured"
	StateHealthy      IntegrationState = "healthy"
	StateError        IntegrationState = "error"
)

// integration declares one probeable dependency. statusFn is pure (reads the
// snapshot, no I/O); probeFn runs the live test.
type integration struct {
	ID       string
	Title    string
	Group    string
	statusFn func(*config.Config) (IntegrationState, string)
	probeFn  func(context.Context, *config.Config) error
}

// ProbeResult is the per-integration row returned to the UI.
type ProbeResult struct {
	ID        string           `json:"id"`
	Title     string           `json:"title"`
	Group     string           `json:"group"`
	State     IntegrationState `json:"state"`
	Summary   string           `json:"summary"`
	Detail    string           `json:"detail,omitempty"`
	LatencyMS int64            `json:"latency_ms,omitempty"`
	TestedAt  *time.Time       `json:"tested_at,omitempty"`
}

// Prober computes integration states and caches the latest live-probe outcome.
type Prober struct {
	center *Center
	mu     sync.Mutex
	last   map[string]ProbeResult
}

func NewProber(c *Center) *Prober { return &Prober{center: c, last: map[string]ProbeResult{}} }

// List returns every integration's current state, merging the cached probe
// outcome when the static state is "configured".
func (p *Prober) List() []ProbeResult {
	cfg := p.center.Snapshot()
	out := make([]ProbeResult, 0, len(integrations))
	p.mu.Lock()
	defer p.mu.Unlock()
	for _, in := range integrations {
		state, summary := in.statusFn(cfg)
		res := ProbeResult{ID: in.ID, Title: in.Title, Group: in.Group, State: state, Summary: summary}
		if state == StateConfigured {
			if cached, ok := p.last[in.ID]; ok {
				res.State = cached.State
				res.Detail = cached.Detail
				res.LatencyMS = cached.LatencyMS
				res.TestedAt = cached.TestedAt
			}
		}
		out = append(out, res)
	}
	return out
}

// Test runs a live probe and caches the result.
func (p *Prober) Test(ctx context.Context, id string) (ProbeResult, error) {
	in, ok := integrationByID[id]
	if !ok {
		return ProbeResult{}, fmt.Errorf("未知集成：%s", id)
	}
	cfg := p.center.Snapshot()
	state, summary := in.statusFn(cfg)
	res := ProbeResult{ID: in.ID, Title: in.Title, Group: in.Group, State: state, Summary: summary}
	if state == StateDisabled || state == StateUnconfigured {
		return res, nil
	}
	start := time.Now()
	err := in.probeFn(ctx, cfg)
	now := time.Now()
	res.TestedAt = &now
	res.LatencyMS = now.Sub(start).Milliseconds()
	if err != nil {
		res.State = StateError
		res.Detail = err.Error()
	} else {
		res.State = StateHealthy
		res.Detail = "连接正常"
	}
	p.mu.Lock()
	p.last[id] = res
	p.mu.Unlock()
	return res, nil
}

// ---- integration catalogue ----

var integrations = []integration{
	{ID: "smtp", Title: "SMTP 邮件", Group: "notify", statusFn: smtpStatus, probeFn: smtpProbe},
	{ID: "docker_anon", Title: "Docker（匿名沙箱）", Group: "anonymous",
		statusFn: dockerStatus(func(c *config.Config) bool { return c.Anonymous.Enabled }), probeFn: dockerProbe},
	{ID: "docker_dbcli", Title: "Docker（数据库命令行）", Group: "protocols",
		statusFn: dockerStatus(func(c *config.Config) bool { return c.Protocols.DBCLI.Enabled }), probeFn: dockerProbe},
	{ID: "guacd", Title: "guacd", Group: "protocols", statusFn: guacdStatus, probeFn: guacdProbe},
	{ID: "devolutions", Title: "Devolutions 网关", Group: "desktop", statusFn: devolutionsStatus, probeFn: devolutionsProbe},
	{ID: "s3archive", Title: "归档对象存储", Group: "archive", statusFn: s3Status, probeFn: s3Probe},
	{ID: "office", Title: "Document Server", Group: "office", statusFn: officeStatus, probeFn: officeProbe},
}

var integrationByID = func() map[string]integration {
	m := make(map[string]integration, len(integrations))
	for _, in := range integrations {
		m[in.ID] = in
	}
	return m
}()

// Integrations returns the static catalogue (id+title+group) for schema.
func Integrations() []ProbeResult {
	out := make([]ProbeResult, 0, len(integrations))
	for _, in := range integrations {
		out = append(out, ProbeResult{ID: in.ID, Title: in.Title, Group: in.Group})
	}
	return out
}

// ---- SMTP ----

func smtpStatus(c *config.Config) (IntegrationState, string) {
	if strings.TrimSpace(c.Notify.SMTP.Host) == "" {
		return StateUnconfigured, "未配置发信服务器"
	}
	return StateConfigured, fmt.Sprintf("%s:%d", c.Notify.SMTP.Host, c.Notify.SMTP.Port)
}

func smtpProbe(ctx context.Context, c *config.Config) error {
	s := c.Notify.SMTP
	addr := fmt.Sprintf("%s:%d", s.Host, s.Port)
	d := net.Dialer{Timeout: 8 * time.Second}
	conn, err := d.DialContext(ctx, "tcp", addr)
	if err != nil {
		return fmt.Errorf("无法连接 %s：%w", addr, err)
	}
	if s.TLS == "tls" {
		conn = tls.Client(conn, &tls.Config{ServerName: s.Host})
	}
	client, err := smtp.NewClient(conn, s.Host)
	if err != nil {
		conn.Close()
		return fmt.Errorf("SMTP 握手失败：%w", err)
	}
	defer client.Close()
	if s.TLS == "starttls" {
		if ok, _ := client.Extension("STARTTLS"); ok {
			if err := client.StartTLS(&tls.Config{ServerName: s.Host}); err != nil {
				return fmt.Errorf("STARTTLS 失败：%w", err)
			}
		} else {
			return fmt.Errorf("服务器不支持 STARTTLS")
		}
	}
	if s.Username != "" {
		auth := smtp.PlainAuth("", s.Username, s.Password, s.Host)
		if err := client.Auth(auth); err != nil {
			return fmt.Errorf("鉴权失败：%w", err)
		}
	}
	return nil
}

// ---- Docker ----

func dockerStatus(enabled func(*config.Config) bool) func(*config.Config) (IntegrationState, string) {
	return func(c *config.Config) (IntegrationState, string) {
		if !enabled(c) {
			return StateDisabled, "未启用"
		}
		return StateConfigured, "本机 Docker 守护进程"
	}
}

func dockerProbe(ctx context.Context, _ *config.Config) error {
	cli, err := dockerx.NewClient()
	if err != nil {
		return fmt.Errorf("无法创建 Docker 客户端：%w", err)
	}
	defer cli.Close()
	pctx, cancel := context.WithTimeout(ctx, 6*time.Second)
	defer cancel()
	if _, err := cli.Ping(pctx); err != nil {
		return fmt.Errorf("Docker 守护进程无响应：%w", err)
	}
	return nil
}

// ---- guacd ----

func guacdStatus(c *config.Config) (IntegrationState, string) {
	if !c.Protocols.Guacamole.Enabled {
		return StateDisabled, "未启用"
	}
	if strings.TrimSpace(c.Protocols.Guacamole.GuacdAddr) == "" {
		return StateUnconfigured, "未配置 guacd 地址"
	}
	return StateConfigured, c.Protocols.Guacamole.GuacdAddr
}

func guacdProbe(ctx context.Context, c *config.Config) error {
	addr := c.Protocols.Guacamole.GuacdAddr
	d := net.Dialer{Timeout: 6 * time.Second}
	conn, err := d.DialContext(ctx, "tcp", addr)
	if err != nil {
		return fmt.Errorf("无法连接 guacd %s：%w", addr, err)
	}
	conn.Close()
	return nil
}

// ---- Devolutions gateway ----

func devolutionsStatus(c *config.Config) (IntegrationState, string) {
	g := c.Desktop.DevolutionsGateway
	if !g.Enabled {
		return StateDisabled, "未启用"
	}
	if strings.TrimSpace(g.ListenAddr) == "" {
		return StateUnconfigured, "未配置监听地址"
	}
	return StateConfigured, g.ListenAddr
}

func devolutionsProbe(ctx context.Context, c *config.Config) error {
	base := strings.TrimRight(c.Desktop.DevolutionsGateway.ListenAddr, "/")
	return httpReachable(ctx, base+"/jet/health", func(code int) bool { return code == 200 })
}

// ---- S3 archive ----

func s3Status(c *config.Config) (IntegrationState, string) {
	a := c.Approval.Archive
	if !a.Enabled {
		return StateDisabled, "未启用"
	}
	if strings.TrimSpace(a.Bucket) == "" {
		return StateUnconfigured, "未配置存储桶"
	}
	target := a.Bucket
	if a.EndpointURL != "" {
		target = a.Bucket + " @ " + a.EndpointURL
	}
	return StateConfigured, target
}

func s3Probe(ctx context.Context, c *config.Config) error {
	a := c.Approval.Archive
	endpoint := a.EndpointURL
	if endpoint == "" {
		region := a.Region
		if region == "" {
			region = "us-east-1"
		}
		endpoint = fmt.Sprintf("https://s3.%s.amazonaws.com", region)
	}
	// Any HTTP status (even 403/404) means the endpoint is reachable; only a
	// transport error counts as down. This verifies reachability without
	// pulling in the full S3 SDK signing path.
	return httpReachable(ctx, endpoint, func(int) bool { return true })
}

// ---- OnlyOffice / Document Server ----

func officeStatus(c *config.Config) (IntegrationState, string) {
	if !c.Office.Enabled {
		return StateDisabled, "未启用"
	}
	if strings.TrimSpace(c.Office.DocumentServerURL) == "" {
		return StateUnconfigured, "未配置 Document Server"
	}
	return StateConfigured, c.Office.DocumentServerURL
}

func officeProbe(ctx context.Context, c *config.Config) error {
	base := strings.TrimRight(c.Office.DocumentServerURL, "/")
	if err := httpReachable(ctx, base+"/healthcheck", func(code int) bool { return code == 200 }); err == nil {
		return nil
	}
	return httpReachable(ctx, base, func(code int) bool { return code < 500 })
}

// httpReachable issues a GET and applies accept() to the status code. Transport
// errors and unacceptable codes both fail.
func httpReachable(ctx context.Context, raw string, accept func(int) bool) error {
	if _, err := url.Parse(raw); err != nil {
		return fmt.Errorf("地址无效：%w", err)
	}
	cctx, cancel := context.WithTimeout(ctx, 8*time.Second)
	defer cancel()
	req, err := http.NewRequestWithContext(cctx, http.MethodGet, raw, nil)
	if err != nil {
		return err
	}
	client := &http.Client{
		Timeout: 8 * time.Second,
		Transport: &http.Transport{
			TLSClientConfig: &tls.Config{InsecureSkipVerify: true}, //nolint:gosec — reachability check only
		},
	}
	resp, err := client.Do(req)
	if err != nil {
		return fmt.Errorf("请求失败：%w", err)
	}
	defer resp.Body.Close()
	if !accept(resp.StatusCode) {
		return fmt.Errorf("返回状态 %d", resp.StatusCode)
	}
	return nil
}
