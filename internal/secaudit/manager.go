package secaudit

import (
	"context"
	"fmt"
	"strconv"
	"strings"
	"sync"
	"time"

	"github.com/michongs/jumpserver-anonymous/internal/asset"
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
	SSH    sshrun.Deps
}

func NewManager(cfg Config, deps Deps) *Manager {
	if cfg.CacheTTL <= 0 {
		cfg.CacheTTL = 15 * time.Second
	}
	if cfg.SSHTimeout <= 0 {
		cfg.SSHTimeout = 20 * time.Second
	}
	m := &Manager{cfg: cfg, logger: deps.Logger, nodes: deps.Nodes, creds: deps.Creds, asset: deps.Asset, deps: deps.SSH, cache: map[uint64]*entry{}}
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

// buildReport turns the raw probe sections into a scored checklist.
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

	// 1. SSH root login
	if v, ok := sshdVal(sec["SSHD"], "permitrootlogin"); ok {
		c := Check{ID: "ssh_root", Title: "SSH root 直登"}
		if v == "yes" {
			c.Status, c.Detail, c.Fix = StatusDanger, "PermitRootLogin=yes，允许 root 直接 SSH 登录", "sudo sed -i 's/^#\\?PermitRootLogin.*/PermitRootLogin prohibit-password/' /etc/ssh/sshd_config && sudo systemctl reload sshd"
		} else {
			c.Status, c.Detail = StatusOK, "PermitRootLogin="+v
		}
		add(c)
	}
	// 2. SSH password auth
	if v, ok := sshdVal(sec["SSHD"], "passwordauthentication"); ok {
		c := Check{ID: "ssh_pw", Title: "SSH 密码认证"}
		if v == "yes" {
			c.Status, c.Detail, c.Fix = StatusWarn, "PasswordAuthentication=yes，建议改用密钥并关闭密码登录", "sudo sed -i 's/^#\\?PasswordAuthentication.*/PasswordAuthentication no/' /etc/ssh/sshd_config && sudo systemctl reload sshd"
		} else {
			c.Status, c.Detail = StatusOK, "PasswordAuthentication="+v
		}
		add(c)
	}
	// 3. Empty passwords
	emptyPw := splitNonEmptyLines(sec["EMPTYPW"])
	if len(emptyPw) > 0 {
		add(Check{ID: "empty_pw", Title: "空密码账户", Status: StatusDanger, Detail: fmt.Sprintf("%d 个账户无密码", len(emptyPw)), Items: emptyPw, Fix: "sudo passwd -l " + emptyPw[0]})
	} else {
		add(Check{ID: "empty_pw", Title: "空密码账户", Status: StatusOK, Detail: "无空密码账户（或无权读取 shadow）"})
	}
	// 4. World-writable files
	ww := splitNonEmptyLines(sec["WW"])
	if len(ww) > 0 {
		add(Check{ID: "world_writable", Title: "世界可写文件", Status: StatusWarn, Detail: fmt.Sprintf("%d 个系统文件全局可写", len(ww)), Items: ww, Fix: "sudo chmod o-w " + ww[0]})
	} else {
		add(Check{ID: "world_writable", Title: "世界可写文件", Status: StatusOK, Detail: "关键目录无全局可写文件"})
	}
	// 5. SUID inventory (informational)
	suid := splitNonEmptyLines(sec["SUID"])
	add(Check{ID: "suid", Title: "SUID 程序清单", Status: StatusInfo, Detail: fmt.Sprintf("%d 个 SUID 程序", len(suid)), Items: suid, Fix: "find / -perm -4000 -type f 2>/dev/null"})
	// 6. Listening ports
	if n, err := strconv.Atoi(strings.TrimSpace(sec["LISTEN"])); err == nil {
		add(Check{ID: "listen", Title: "监听端口", Status: StatusInfo, Detail: fmt.Sprintf("%d 个 TCP 监听", n), Fix: "ss -tlnp"})
	}
	// 7. fail2ban
	f2b := strings.TrimSpace(sec["FAIL2BAN"])
	if strings.Contains(f2b, "__NOFAIL2BAN__") || f2b == "" {
		add(Check{ID: "fail2ban", Title: "fail2ban 防护", Status: StatusWarn, Detail: "未检测到 fail2ban，建议安装以拦截暴力破解", Fix: "sudo apt-get install -y fail2ban || sudo yum install -y fail2ban"})
	} else {
		add(Check{ID: "fail2ban", Title: "fail2ban 防护", Status: StatusOK, Detail: "fail2ban 正在运行"})
	}
	// 8. Failed logins
	if n, err := strconv.Atoi(strings.TrimSpace(sec["LASTB"])); err == nil && n >= 0 {
		c := Check{ID: "failed_logins", Title: "失败登录", Detail: fmt.Sprintf("%d 条失败登录记录", n), Fix: "sudo lastb | head -50"}
		if n >= 100 {
			c.Status = StatusWarn
		} else {
			c.Status = StatusInfo
		}
		add(c)
	}

	if score < 0 {
		score = 0
	}
	return Report{Score: score, Checks: checks, SampledAt: time.Now().UTC()}
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
