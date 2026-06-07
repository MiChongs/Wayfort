package secaudit

import (
	"context"
	"fmt"
	"strconv"
	"strings"
	"sync"
	"time"

	"github.com/michongs/jumpserver-anonymous/internal/asset"
	"github.com/michongs/jumpserver-anonymous/internal/audit"
	"github.com/michongs/jumpserver-anonymous/internal/model"
	"github.com/michongs/jumpserver-anonymous/internal/repo"
	"github.com/michongs/jumpserver-anonymous/internal/sshrun"
	"go.uber.org/zap"
	"golang.org/x/sync/singleflight"
)

type Config struct {
	Enabled    bool
	CacheTTL   time.Duration // default 15s — checks are heavyish (find)
	SSHTimeout time.Duration // default 20s
}

type Manager struct {
	cfg    Config
	logger *zap.Logger
	nodes  *repo.NodeRepo
	creds  *repo.CredentialRepo
	asset  *asset.Resolver
	audit  *audit.Writer
	deps   sshrun.Deps

	mu     sync.Mutex
	cache  map[uint64]*entry
	flight singleflight.Group
}

type entry struct {
	at     time.Time
	report Report
}

type Deps struct {
	Logger *zap.Logger
	Nodes  *repo.NodeRepo
	Creds  *repo.CredentialRepo
	Asset  *asset.Resolver
	Audit  *audit.Writer
	SSH    sshrun.Deps
}

func NewManager(cfg Config, deps Deps) *Manager {
	if cfg.CacheTTL <= 0 {
		cfg.CacheTTL = 15 * time.Second
	}
	if cfg.SSHTimeout <= 0 {
		cfg.SSHTimeout = 20 * time.Second
	}
	m := &Manager{cfg: cfg, logger: deps.Logger, nodes: deps.Nodes, creds: deps.Creds, asset: deps.Asset, audit: deps.Audit, deps: deps.SSH, cache: map[uint64]*entry{}}
	if m.logger != nil {
		m.logger.Info("secaudit subsystem ready", zap.Bool("enabled", cfg.Enabled))
	}
	return m
}

func (m *Manager) Enabled() bool { return m.cfg.Enabled }

func (m *Manager) Report(ctx context.Context, userID, nodeID uint64) (*Report, error) {
	loaded, err := m.gateAndLoad(ctx, userID, nodeID)
	if err != nil {
		return nil, err
	}
	m.mu.Lock()
	if c, ok := m.cache[nodeID]; ok && time.Since(c.at) < m.cfg.CacheTTL {
		r := c.report
		m.mu.Unlock()
		return &r, nil
	}
	m.mu.Unlock()
	v, err, _ := m.flight.Do(fmt.Sprintf("sec:%d", nodeID), func() (any, error) {
		return m.collect(ctx, nodeID, loaded)
	})
	if err != nil {
		return nil, err
	}
	return v.(*Report), nil
}

func (m *Manager) collect(ctx context.Context, nodeID uint64, l *nodeAndCred) (*Report, error) {
	cctx, cancel := context.WithTimeout(ctx, m.cfg.SSHTimeout)
	defer cancel()
	res, err := sshrun.Run(cctx, m.deps, l.node, l.cred, auditScript, m.cfg.SSHTimeout)
	if err != nil && res.Stdout == "" {
		return nil, classifySSHError(err, "security audit")
	}
	report := buildReport(splitSections(res.Stdout))
	m.mu.Lock()
	m.cache[nodeID] = &entry{at: time.Now(), report: report}
	m.mu.Unlock()
	return &report, nil
}

// buildReport turns the raw probe sections into a scored, categorised checklist.
func buildReport(sec map[string]string) Report {
	score := 100
	checks := []Check{}
	add := func(c Check) {
		checks = append(checks, c)
		switch c.Status {
		case StatusDanger:
			score -= 20
		case StatusWarn:
			score -= 8
		}
	}

	// ---- SSH ----
	if v, ok := sshdVal(sec["SSHD"], "permitrootlogin"); ok {
		c := Check{ID: "ssh_root", Category: "SSH", Title: "SSH root 直登"}
		if v == "yes" {
			c.Status, c.Detail, c.Fix, c.Applicable = StatusDanger, "PermitRootLogin=yes，允许 root 直接 SSH 登录", fixCommands["ssh_root"], true
		} else {
			c.Status, c.Detail = StatusOK, "PermitRootLogin="+v
		}
		add(c)
	}
	if v, ok := sshdVal(sec["SSHD"], "passwordauthentication"); ok {
		c := Check{ID: "ssh_pw", Category: "SSH", Title: "SSH 密码认证"}
		if v == "yes" {
			c.Status, c.Detail, c.Fix, c.Applicable = StatusWarn, "PasswordAuthentication=yes，建议改用密钥并关闭密码登录", fixCommands["ssh_pw"], true
		} else {
			c.Status, c.Detail = StatusOK, "PasswordAuthentication="+v
		}
		add(c)
	}
	if v, ok := sshdVal(sec["SSHD"], "permitemptypasswords"); ok {
		c := Check{ID: "ssh_emptypw", Category: "SSH", Title: "SSH 空密码登录"}
		if v == "yes" {
			c.Status, c.Detail = StatusDanger, "PermitEmptyPasswords=yes — 极危险"
		} else {
			c.Status, c.Detail = StatusOK, "PermitEmptyPasswords="+v
		}
		add(c)
	}

	// ---- 账户 ----
	emptyPw := splitNonEmptyLines(sec["EMPTYPW"])
	if len(emptyPw) > 0 {
		add(Check{ID: "empty_pw", Category: "账户", Title: "空密码账户", Status: StatusDanger, Detail: fmt.Sprintf("%d 个账户无密码", len(emptyPw)), Items: emptyPw, Fix: "sudo passwd -l " + emptyPw[0]})
	} else {
		add(Check{ID: "empty_pw", Category: "账户", Title: "空密码账户", Status: StatusOK, Detail: "无空密码账户（或无权读取 shadow）"})
	}
	uid0 := splitNonEmptyLines(sec["UID0"])
	if len(uid0) > 1 {
		add(Check{ID: "uid0", Category: "账户", Title: "UID 0 账户", Status: StatusDanger, Detail: fmt.Sprintf("除 root 外还有 %d 个 UID=0 账户", len(uid0)-1), Items: uid0})
	} else {
		add(Check{ID: "uid0", Category: "账户", Title: "UID 0 账户", Status: StatusOK, Detail: "仅 root 拥有 UID 0"})
	}
	if pol := strings.TrimSpace(sec["PASSPOLICY"]); pol != "" {
		c := Check{ID: "pass_policy", Category: "账户", Title: "口令最长有效期", Detail: pol}
		if strings.Contains(pol, "99999") {
			c.Status, c.Fix = StatusWarn, "sudo sed -i 's/^PASS_MAX_DAYS.*/PASS_MAX_DAYS 90/' /etc/login.defs"
		} else {
			c.Status = StatusOK
		}
		add(c)
	}
	authkeys := splitNonEmptyLines(sec["AUTHKEYS"])
	add(Check{ID: "authkeys", Category: "账户", Title: "authorized_keys", Status: StatusInfo, Detail: fmt.Sprintf("%d 个 authorized_keys 文件", len(authkeys)), Items: authkeys})
	if rc := splitNonEmptyLines(sec["ROOTCRON"]); len(rc) > 0 {
		add(Check{ID: "root_cron", Category: "账户", Title: "root 定时任务", Status: StatusInfo, Detail: fmt.Sprintf("root crontab 有 %d 条", len(rc)), Items: rc})
	}

	// ---- 文件权限 ----
	ww := splitNonEmptyLines(sec["WW"])
	if len(ww) > 0 {
		add(Check{ID: "world_writable", Category: "文件权限", Title: "世界可写文件", Status: StatusWarn, Detail: fmt.Sprintf("%d 个系统文件全局可写", len(ww)), Items: ww, Fix: "sudo chmod o-w " + ww[0]})
	} else {
		add(Check{ID: "world_writable", Category: "文件权限", Title: "世界可写文件", Status: StatusOK, Detail: "关键目录无全局可写文件"})
	}
	suid := splitNonEmptyLines(sec["SUID"])
	add(Check{ID: "suid", Category: "文件权限", Title: "SUID 程序清单", Status: StatusInfo, Detail: fmt.Sprintf("%d 个 SUID 程序", len(suid)), Items: suid, Fix: "find / -perm -4000 -type f 2>/dev/null"})

	// ---- 网络与防护 ----
	if n, err := strconv.Atoi(strings.TrimSpace(sec["LISTEN"])); err == nil {
		add(Check{ID: "listen", Category: "网络与防护", Title: "监听端口", Status: StatusInfo, Detail: fmt.Sprintf("%d 个 TCP 监听", n), Fix: "ss -tlnp"})
	}
	f2b := strings.TrimSpace(sec["FAIL2BAN"])
	if strings.Contains(f2b, "__NOFAIL2BAN__") || f2b == "" {
		add(Check{ID: "fail2ban", Category: "网络与防护", Title: "fail2ban 防护", Status: StatusWarn, Detail: "未检测到 fail2ban，建议安装以拦截暴力破解", Fix: fixCommands["fail2ban"], Applicable: true})
	} else {
		add(Check{ID: "fail2ban", Category: "网络与防护", Title: "fail2ban 防护", Status: StatusOK, Detail: "fail2ban 正在运行"})
	}
	if n, err := strconv.Atoi(strings.TrimSpace(sec["LASTB"])); err == nil && n >= 0 {
		c := Check{ID: "failed_logins", Category: "网络与防护", Title: "失败登录", Detail: fmt.Sprintf("%d 条失败登录记录", n), Fix: "sudo lastb | head -50"}
		if n >= 100 {
			c.Status = StatusWarn
		} else {
			c.Status = StatusInfo
		}
		add(c)
	}

	// ---- 内核加固 ----
	sel := strings.TrimSpace(sec["SELINUX"])
	selLow := strings.ToLower(sel)
	c := Check{ID: "mac", Category: "内核加固", Title: "强制访问控制 (SELinux/AppArmor)"}
	switch {
	case strings.Contains(selLow, "enforcing") || strings.Contains(sel, "__APPARMOR_ENFORCING__"):
		c.Status, c.Detail = StatusOK, "SELinux/AppArmor 处于强制模式"
	case strings.Contains(selLow, "permissive"):
		c.Status, c.Detail = StatusWarn, "SELinux 为 permissive（仅告警不拦截）"
	case strings.Contains(selLow, "disabled") || sel == "":
		c.Status, c.Detail = StatusWarn, "未启用 SELinux/AppArmor 强制访问控制"
	default:
		c.Status, c.Detail = StatusInfo, sel
	}
	add(c)

	hv := parseHarden(sec["HARDEN"])
	hardenOK := hv["randomize_va_space"] == "2" && hv["tcp_syncookies"] == "1" && hv["rp_filter"] == "1"
	hc := Check{ID: "harden", Category: "内核加固", Title: "内核加固 sysctl"}
	if hardenOK {
		hc.Status, hc.Detail = StatusOK, "ASLR / SYN cookies / rp_filter 均已开启"
	} else {
		hc.Status, hc.Detail, hc.Fix, hc.Applicable = StatusWarn,
			fmt.Sprintf("ASLR=%s syncookies=%s rp_filter=%s（建议均为 2/1/1）", hv["randomize_va_space"], hv["tcp_syncookies"], hv["rp_filter"]),
			fixCommands["harden"], true
	}
	add(hc)

	reboot := sec["REBOOT"]
	if strings.Contains(reboot, "__REBOOT_REQUIRED__") || strings.Contains(reboot, "needsrestart_rc=1") {
		add(Check{ID: "reboot", Category: "内核加固", Title: "待重启", Status: StatusWarn, Detail: "有内核/库更新待生效，建议择机重启", Fix: "sudo reboot"})
	} else {
		add(Check{ID: "reboot", Category: "内核加固", Title: "待重启", Status: StatusOK, Detail: "无待生效的重启"})
	}

	un := sec["UNATTENDED"]
	if strings.Contains(un, "__UNATTENDED_ON__") || strings.Contains(un, "__DNF_AUTO_ON__") {
		add(Check{ID: "unattended", Category: "内核加固", Title: "自动安全更新", Status: StatusOK, Detail: "已启用自动安全更新"})
	} else {
		add(Check{ID: "unattended", Category: "内核加固", Title: "自动安全更新", Status: StatusWarn, Detail: "未启用自动安全更新", Fix: fixCommands["unattended"], Applicable: true})
	}

	if score < 0 {
		score = 0
	}
	return Report{Score: score, Checks: checks, SampledAt: time.Now().UTC()}
}

// parseHarden reads the `key=value` lines emitted for the sysctl hardening probe.
func parseHarden(s string) map[string]string {
	m := map[string]string{}
	for _, line := range splitNonEmptyLines(s) {
		k, v, ok := strings.Cut(line, "=")
		if ok {
			m[strings.TrimSpace(k)] = strings.TrimSpace(v)
		}
	}
	return m
}

// fixCommands maps an Applicable check id to its canonical, idempotent fix. Only
// these blanket fixes can be applied server-side via Apply; per-item fixes
// (chmod a specific file, lock a specific account) stay copy-to-terminal.
var fixCommands = map[string]string{
	"ssh_root":   "sed -i 's/^#\\?PermitRootLogin.*/PermitRootLogin prohibit-password/' /etc/ssh/sshd_config && systemctl reload sshd 2>/dev/null || systemctl reload ssh",
	"ssh_pw":     "sed -i 's/^#\\?PasswordAuthentication.*/PasswordAuthentication no/' /etc/ssh/sshd_config && systemctl reload sshd 2>/dev/null || systemctl reload ssh",
	"fail2ban":   "(apt-get install -y fail2ban || yum install -y fail2ban || dnf install -y fail2ban) && systemctl enable --now fail2ban",
	"harden":     "sysctl -w kernel.randomize_va_space=2 net.ipv4.tcp_syncookies=1 net.ipv4.conf.all.rp_filter=1 && printf 'kernel.randomize_va_space=2\\nnet.ipv4.tcp_syncookies=1\\nnet.ipv4.conf.all.rp_filter=1\\n' > /etc/sysctl.d/99-jumpserver-harden.conf",
	"unattended": "(apt-get install -y unattended-upgrades && dpkg-reconfigure -f noninteractive unattended-upgrades) || (dnf install -y dnf-automatic && systemctl enable --now dnf-automatic.timer)",
}

// Apply runs the canonical blanket fix for an Applicable check (security:manage).
func (m *Manager) Apply(ctx context.Context, userID, nodeID uint64, claims AuditClaims, checkID string) (string, error) {
	loaded, err := m.gateAndLoad(ctx, userID, nodeID)
	if err != nil {
		return "", err
	}
	cmd, ok := fixCommands[checkID]
	if !ok {
		return "", ErrNotApplicable
	}
	cctx, cancel := context.WithTimeout(ctx, 120*time.Second)
	defer cancel()
	res, err := sshrun.Run(cctx, m.deps, loaded.node, loaded.cred, cmd+" 2>&1", 120*time.Second)
	out := res.Stdout
	if out == "" {
		out = res.Stderr
	}
	low := strings.ToLower(out)
	if strings.Contains(low, "permission denied") || strings.Contains(low, "must be root") || strings.Contains(low, "not permitted") {
		return "", fmt.Errorf("%w: %s", ErrPermissionDenied, truncate(out, 160))
	}
	if err != nil && out == "" {
		return "", classifySSHError(err, "apply "+checkID)
	}
	m.mu.Lock()
	delete(m.cache, nodeID)
	m.mu.Unlock()
	if m.audit != nil {
		nid := nodeID
		m.audit.Log(model.AuditLog{Kind: model.AuditSecurityAction, UserID: claims.UserID, Username: claims.Username, NodeID: &nid, ClientIP: claims.ClientIP, Payload: "apply " + checkID})
	}
	return strings.TrimRight(out, "\n"), nil
}

func truncate(s string, n int) string {
	if len(s) <= n {
		return s
	}
	return s[:n]
}

type nodeAndCred struct {
	node *model.Node
	cred *model.Credential
}

func (m *Manager) gateAndLoad(ctx context.Context, userID, nodeID uint64) (*nodeAndCred, error) {
	if !m.cfg.Enabled {
		return nil, ErrDisabled
	}
	if m.asset != nil {
		ok, err := m.asset.Check(ctx, userID, nodeID, asset.ActionConnect)
		if err != nil {
			return nil, fmt.Errorf("asset check: %w", err)
		}
		if !ok {
			return nil, ErrUnauthorized
		}
	}
	node, err := m.nodes.FindByID(ctx, nodeID)
	if err != nil || node == nil {
		return nil, fmt.Errorf("node %d not found", nodeID)
	}
	if node.Disabled {
		return nil, fmt.Errorf("node disabled")
	}
	cred, err := m.creds.FindByID(ctx, node.CredentialID)
	if err != nil || cred == nil {
		return nil, fmt.Errorf("credential lookup failed")
	}
	return &nodeAndCred{node: node, cred: cred}, nil
}

func classifySSHError(err error, op string) error {
	if err == nil {
		return nil
	}
	e := strings.ToLower(err.Error())
	if strings.Contains(e, "unable to authenticate") || strings.Contains(e, "no route to host") ||
		strings.Contains(e, "i/o timeout") || strings.Contains(e, "connection refused") {
		return fmt.Errorf("%w: %v (%s)", ErrUnreachable, err, op)
	}
	return fmt.Errorf("%s: %w", op, err)
}

func splitSections(raw string) map[string]string {
	out := map[string]string{}
	cur := ""
	var buf strings.Builder
	for _, line := range strings.Split(raw, "\n") {
		t := strings.TrimRight(line, "\r")
		if strings.HasPrefix(t, "===") && strings.HasSuffix(t, "===") && len(t) > 6 {
			out[cur] = buf.String()
			cur = strings.Trim(t, "= ")
			buf.Reset()
			continue
		}
		buf.WriteString(t)
		buf.WriteByte('\n')
	}
	out[cur] = buf.String()
	delete(out, "END")
	return out
}
