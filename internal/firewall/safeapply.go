package firewall

import (
	"context"
	"encoding/base64"
	"fmt"
	"strconv"
	"strings"
	"time"

	"github.com/michongs/wayfort/internal/model"
)

// safeapply.go is the anti-lockout core. Managing a firewall over SSH means one
// bad rule can lock you out for good. Before any high-risk change we:
//  1. ensureSSHGuard — top-insert an allow for the SSH port so the management
//     path (gateway → node) can never be cut. The SSH connection originates from
//     the gateway, not the browser, so we keep the port open rather than pin a
//     source IP we can't know reliably.
//  2. SnapshotRuleset — save the current ruleset on the host.
//  3. armRollback — schedule a host-side watchdog (systemd-run, else setsid)
//     that restores the snapshot after N seconds UNLESS a commit file appears.
//     The watchdog is detached from the SSH session, so it fires even if the
//     browser crashes or the connection drops.
// CommitApply cancels the watchdog and persists. RollbackNow triggers it early.

const jsfwDir = "/var/tmp/jsfw"

func nowStamp() string { return time.Now().UTC().Format("20060102T150405Z") }

// SafeApply runs a change with auto-rollback protection and returns the arm
// token + deadline so the UI can show a countdown. High-risk changes require
// confirm=true. Gated by firewall:manage.
func (m *Manager) SafeApply(ctx context.Context, userID, nodeID uint64, claims AuditClaims, req ApplyRequest) (*SafeApplyResult, error) {
	l, err := m.gateAndLoad(ctx, userID, nodeID)
	if err != nil {
		return nil, err
	}
	status, rules, err := m.snapshot(ctx, userID, nodeID)
	if err != nil {
		return nil, err
	}
	if status.Tool == ToolUnsupported {
		return nil, ErrNoTool
	}

	high, reasons := m.isHighRisk(req, status, rules)
	if high && !req.Confirm {
		return nil, ErrConfirmRequired
	}

	// Serialise arming per node.
	m.mu.Lock()
	if a, ok := m.armed[nodeID]; ok && time.Now().Before(a.expiresAt) {
		m.mu.Unlock()
		return nil, ErrAlreadyArmed
	}
	m.mu.Unlock()

	cmds, err := m.buildChangeCommands(status, rules, req)
	if err != nil {
		return nil, err
	}
	if len(cmds) == 0 {
		return nil, ErrBadArg
	}

	armSec := req.TTLSeconds
	if armSec <= 0 {
		armSec = m.cfg.DefaultArmSeconds
	}

	res := &SafeApplyResult{
		ArmSeconds: armSec,
		HighRisk:   high,
		Plan:       &ApplyPlan{Commands: cmds, HighRisk: high, RiskReasons: reasons},
	}

	if high {
		// 1) keep SSH open
		guard, gerr := m.ensureSSHGuard(ctx, l, status)
		if gerr != nil {
			return nil, gerr
		}
		res.SSHGuard = guard
		// 2) snapshot
		snapID := fmt.Sprintf("%s-%d", nowStamp(), nodeID)
		if err := m.snapshotRuleset(ctx, l, status.Tool, snapID); err != nil {
			return nil, err
		}
		res.SnapshotID = snapID
		res.ArmToken = snapID
		// 3) arm host-side watchdog
		via, jobRef, err := m.armRollback(ctx, l, status.Tool, snapID, armSec)
		if err != nil {
			return nil, err
		}
		res.RollbackVia, res.JobRef = via, jobRef
		res.Deadline = time.Now().UTC().Add(time.Duration(armSec) * time.Second)
	}

	// 4) execute the change
	if err := m.runCmds(ctx, l, cmds); err != nil {
		// roll back immediately on failure of a high-risk change
		if high {
			_ = m.triggerRollback(ctx, l, status.Tool, res.SnapshotID, res.RollbackVia, res.JobRef)
			m.clearArmed(nodeID)
		}
		return nil, err
	}

	switch status.Tool {
	case ToolNftables:
		_ = m.persistNft(ctx, l)
	case ToolIPTables:
		_ = m.persistIptables(ctx, l)
	}
	m.invalidate(nodeID)

	if high {
		m.setArmed(nodeID, res, armSec)
	}
	m.recordAudit(claims, nodeID, model.AuditFirewallChange,
		fmt.Sprintf("safe-apply %s high_risk=%v arm=%ds snap=%s via=%s", req.Kind, high, armSec, res.SnapshotID, res.RollbackVia))
	return res, nil
}

// CommitApply cancels a pending rollback and persists the (confirmed-good)
// state. Gated by firewall:manage.
func (m *Manager) CommitApply(ctx context.Context, userID, nodeID uint64, claims AuditClaims, token string) error {
	l, err := m.gateAndLoad(ctx, userID, nodeID)
	if err != nil {
		return err
	}
	a := m.getArmed(nodeID)
	if a == nil || (token != "" && a.token != token) {
		return ErrNoSnapshot
	}
	status, _, _ := m.snapshot(ctx, userID, nodeID)
	inner := fmt.Sprintf(`touch %s/%s.commit; `, jsfwDir, a.snapID)
	switch a.via {
	case "systemd":
		inner += fmt.Sprintf(`systemctl stop jsfw-rollback-%s.timer 2>/dev/null; systemctl reset-failed jsfw-rollback-%s.timer 2>/dev/null; `, a.snapID, a.snapID)
	case "nohup":
		inner += fmt.Sprintf(`[ -f %s/%s.pid ] && kill "$(cat %s/%s.pid)" 2>/dev/null; `, jsfwDir, a.snapID, jsfwDir, a.snapID)
	}
	cmd := fmt.Sprintf("sudo -n sh -c %s 2>&1 || sh -c %s 2>&1", shellQuote(inner), shellQuote(inner))
	if _, err := m.runFW(ctx, l, cmd, "commit", m.cfg.SSHTimeout); err != nil {
		return err
	}
	switch status.Tool {
	case ToolNftables:
		_ = m.persistNft(ctx, l)
	case ToolIPTables:
		_ = m.persistIptables(ctx, l)
	}
	m.clearArmed(nodeID)
	m.invalidate(nodeID)
	m.recordAudit(claims, nodeID, model.AuditFirewallChange, "safe-apply commit snap="+a.snapID)
	return nil
}

// RollbackNow triggers the pending rollback immediately. Gated by firewall:manage.
func (m *Manager) RollbackNow(ctx context.Context, userID, nodeID uint64, claims AuditClaims, token string) error {
	l, err := m.gateAndLoad(ctx, userID, nodeID)
	if err != nil {
		return err
	}
	a := m.getArmed(nodeID)
	if a == nil || (token != "" && a.token != token) {
		return ErrNoSnapshot
	}
	status, _, _ := m.snapshot(ctx, userID, nodeID)
	if err := m.triggerRollback(ctx, l, status.Tool, a.snapID, a.via, a.jobRef); err != nil {
		return err
	}
	m.clearArmed(nodeID)
	m.invalidate(nodeID)
	m.recordAudit(claims, nodeID, model.AuditFirewallChange, "safe-apply rollback snap="+a.snapID)
	return nil
}

// ---- risk assessment ----

func (m *Manager) isHighRisk(req ApplyRequest, st Status, rules []Rule) (bool, []string) {
	var reasons []string
	switch req.Kind {
	case ApplyImport:
		reasons = append(reasons, "整套规则集替换")
	case ApplyTemplate:
		reasons = append(reasons, "套用策略模板（含默认拒绝）")
	case ApplyPolicy:
		reasons = append(reasons, "修改默认入站策略")
	case ApplyAdd, ApplyInsert, ApplyEdit:
		sp := specOf(req)
		if sp != nil && sp.Action != "ALLOW" && portMatches(sp.Port, st.SSHPort) {
			reasons = append(reasons, fmt.Sprintf("规则会拦截当前 SSH 端口 %d", st.SSHPort))
		}
	case ApplyDelete, ApplyBulk, ApplyReorder:
		idxs := req.Indexes
		if req.Move != nil {
			idxs = append(idxs, req.Move.From)
		}
		for _, idx := range idxs {
			if r := ruleByIndex(rules, idx); r != nil && strings.EqualFold(r.Action, "ALLOW") && portMatches(r.Port, st.SSHPort) {
				reasons = append(reasons, fmt.Sprintf("会移除放行 SSH 端口 %d 的规则", st.SSHPort))
				break
			}
		}
	}
	return len(reasons) > 0, reasons
}

func specOf(req ApplyRequest) *RuleSpec {
	switch {
	case req.Spec != nil:
		return req.Spec
	case req.Insert != nil:
		return &req.Insert.Spec
	case req.Edit != nil:
		return &req.Edit.NewSpec
	}
	return nil
}

// ---- SSH guard ----

func (m *Manager) ensureSSHGuard(ctx context.Context, l *nodeAndCred, st Status) (string, error) {
	port := st.SSHPort
	if port <= 0 {
		return "", nil
	}
	p := strconv.Itoa(port)
	var inner string
	switch st.Tool {
	case ToolUFW:
		inner = fmt.Sprintf(`ufw status 2>/dev/null | grep -qE "%s/tcp.*ALLOW" || ufw insert 1 allow in proto tcp from any to any port %s`, p, p)
	case ToolIPTables:
		inner = fmt.Sprintf(`iptables -C INPUT -p tcp --dport %s -j ACCEPT 2>/dev/null || iptables -I INPUT 1 -p tcp --dport %s -j ACCEPT`, p, p)
	case ToolNftables:
		inner = fmt.Sprintf(`nft list chain inet filter input 2>/dev/null | grep -q "dport %s .*accept" || nft insert rule inet filter input tcp dport %s counter accept`, p, p)
	default:
		return "", nil
	}
	cmd := fmt.Sprintf("sudo -n sh -c %s 2>&1 || sh -c %s 2>&1", shellQuote(inner), shellQuote(inner))
	if _, err := m.runFW(ctx, l, cmd, "ssh guard", m.cfg.SSHTimeout); err != nil {
		return "", err
	}
	return fmt.Sprintf("allow tcp/%d from any (anti-lockout)", port), nil
}

// ---- snapshot + rollback (host-side, detached from SSH) ----

func (m *Manager) snapshotRuleset(ctx context.Context, l *nodeAndCred, tool Tool, id string) error {
	inner := fmt.Sprintf(`mkdir -p %s; chmod 700 %s; `, jsfwDir, jsfwDir)
	switch tool {
	case ToolUFW:
		inner += fmt.Sprintf(`cp -a /etc/ufw/user.rules %s/%s.ufw 2>/dev/null; cp -a /etc/ufw/user6.rules %s/%s.ufw6 2>/dev/null; :`, jsfwDir, id, jsfwDir, id)
	case ToolNftables:
		inner += fmt.Sprintf(`nft list ruleset > %s/%s.nft 2>/dev/null; :`, jsfwDir, id)
	case ToolIPTables:
		inner += fmt.Sprintf(`iptables-save > %s/%s.v4 2>/dev/null; ip6tables-save > %s/%s.v6 2>/dev/null; :`, jsfwDir, id, jsfwDir, id)
	}
	cmd := fmt.Sprintf("sudo -n sh -c %s 2>&1 || sh -c %s 2>&1", shellQuote(inner), shellQuote(inner))
	_, err := m.runFW(ctx, l, cmd, "snapshot ruleset", m.cfg.SSHTimeout)
	return err
}

// restoreScript builds the host-side restore script for the tool/snapshot. It
// is a no-op once a .commit marker exists.
func restoreScript(tool Tool, id string) string {
	var body string
	switch tool {
	case ToolUFW:
		body = fmt.Sprintf("cp -a %s/%s.ufw /etc/ufw/user.rules 2>/dev/null; cp -a %s/%s.ufw6 /etc/ufw/user6.rules 2>/dev/null; ufw reload 2>/dev/null", jsfwDir, id, jsfwDir, id)
	case ToolNftables:
		body = fmt.Sprintf("nft flush ruleset 2>/dev/null; nft -f %s/%s.nft 2>/dev/null", jsfwDir, id)
	case ToolIPTables:
		body = fmt.Sprintf("iptables-restore < %s/%s.v4 2>/dev/null; ip6tables-restore < %s/%s.v6 2>/dev/null", jsfwDir, id, jsfwDir, id)
	}
	return fmt.Sprintf("#!/bin/sh\n[ -f %s/%s.commit ] && exit 0\n%s\necho done > %s/%s.fired\n", jsfwDir, id, body, jsfwDir, id)
}

// armRollback writes the restore script and schedules it detached from this SSH
// session. Prefers systemd-run (named, cancellable), else setsid+sleep. Returns
// the mechanism + job ref.
func (m *Manager) armRollback(ctx context.Context, l *nodeAndCred, tool Tool, id string, armSec int) (string, string, error) {
	b64 := base64.StdEncoding.EncodeToString([]byte(restoreScript(tool, id)))
	sh := fmt.Sprintf(`printf %%s %s | base64 -d > %s/%s.restore.sh; chmod 700 %s/%s.restore.sh
if command -v systemd-run >/dev/null 2>&1 && systemctl is-system-running >/dev/null 2>&1; then
  systemd-run --unit=jsfw-rollback-%s --on-active=%ds /bin/sh %s/%s.restore.sh >/dev/null 2>&1 && echo "VIA=systemd JOB=jsfw-rollback-%s"
elif command -v setsid >/dev/null 2>&1; then
  setsid sh -c "sleep %d; sh %s/%s.restore.sh" >/dev/null 2>&1 & echo $! > %s/%s.pid; echo "VIA=nohup JOB=$(cat %s/%s.pid)"
else
  nohup sh -c "sleep %d; sh %s/%s.restore.sh" >/dev/null 2>&1 & echo $! > %s/%s.pid; echo "VIA=nohup JOB=$(cat %s/%s.pid)"
fi`,
		b64, jsfwDir, id, jsfwDir, id,
		id, armSec, jsfwDir, id, id,
		armSec, jsfwDir, id, jsfwDir, id, jsfwDir, id,
		armSec, jsfwDir, id, jsfwDir, id, jsfwDir, id)
	cmd := fmt.Sprintf("sudo -n sh -c %s 2>&1 || sh -c %s 2>&1", shellQuote(sh), shellQuote(sh))
	out, err := m.runFW(ctx, l, cmd, "arm rollback", m.cfg.SSHTimeout)
	if err != nil {
		return "", "", err
	}
	via, jobRef := "nohup", ""
	for _, line := range strings.Fields(out) {
		if v, ok := strings.CutPrefix(line, "VIA="); ok {
			via = v
		}
		if j, ok := strings.CutPrefix(line, "JOB="); ok {
			jobRef = j
		}
	}
	return via, jobRef, nil
}

// triggerRollback runs the restore now (used on apply failure / explicit
// rollback) and cancels the scheduled watchdog.
func (m *Manager) triggerRollback(ctx context.Context, l *nodeAndCred, tool Tool, id, via, jobRef string) error {
	if id == "" {
		return nil
	}
	inner := fmt.Sprintf(`sh %s/%s.restore.sh 2>/dev/null; `, jsfwDir, id)
	switch via {
	case "systemd":
		inner += fmt.Sprintf(`systemctl stop jsfw-rollback-%s.timer 2>/dev/null; `, id)
	case "nohup":
		inner += fmt.Sprintf(`[ -f %s/%s.pid ] && kill "$(cat %s/%s.pid)" 2>/dev/null; `, jsfwDir, id, jsfwDir, id)
	}
	cmd := fmt.Sprintf("sudo -n sh -c %s 2>&1 || sh -c %s 2>&1", shellQuote(inner), shellQuote(inner))
	_, err := m.runFW(ctx, l, cmd, "rollback now", m.cfg.SSHTimeout)
	return err
}

// ---- arm state (in-memory) ----

func (m *Manager) setArmed(nodeID uint64, res *SafeApplyResult, armSec int) {
	m.mu.Lock()
	m.armed[nodeID] = &armState{
		token: res.ArmToken, snapID: res.SnapshotID, via: res.RollbackVia, jobRef: res.JobRef,
		expiresAt: time.Now().Add(time.Duration(armSec+10) * time.Second),
	}
	m.mu.Unlock()
	// best-effort: clear stale arm state after the window (host self-manages).
	time.AfterFunc(time.Duration(armSec+10)*time.Second, func() { m.clearArmedIfExpired(nodeID) })
}

func (m *Manager) getArmed(nodeID uint64) *armState {
	m.mu.Lock()
	defer m.mu.Unlock()
	return m.armed[nodeID]
}
func (m *Manager) clearArmed(nodeID uint64) {
	m.mu.Lock()
	delete(m.armed, nodeID)
	m.mu.Unlock()
}
func (m *Manager) clearArmedIfExpired(nodeID uint64) {
	m.mu.Lock()
	if a, ok := m.armed[nodeID]; ok && time.Now().After(a.expiresAt) {
		delete(m.armed, nodeID)
	}
	m.mu.Unlock()
}

// ---- command building + execution ----

func (m *Manager) buildChangeCommands(st Status, rules []Rule, req ApplyRequest) ([]string, error) {
	switch req.Kind {
	case ApplyAdd:
		if req.Spec == nil {
			return nil, ErrBadSpec
		}
		if err := sanitizeSpec(req.Spec); err != nil {
			return nil, err
		}
		c, err := buildAddCommand(st.Tool, *req.Spec)
		if err != nil {
			return nil, err
		}
		return []string{c}, nil
	case ApplyInsert:
		if req.Insert == nil {
			return nil, ErrBadSpec
		}
		if err := sanitizeSpec(&req.Insert.Spec); err != nil {
			return nil, err
		}
		return []string{m.insertCmd(st.Tool, rules, req.Insert.At, req.Insert.Spec)}, nil
	case ApplyTemplate:
		tpl := templateByID(req.TemplateID)
		if tpl == nil {
			return nil, ErrBadArg
		}
		return buildTemplateCommands(tpl, st.Tool, st.SSHPort), nil
	case ApplyImport:
		if req.Content == "" {
			return nil, ErrBadArg
		}
		b64 := base64.StdEncoding.EncodeToString([]byte(req.Content))
		c := buildImportCommand(st.Tool, req.Format, b64)
		if c == "" {
			return nil, ErrEditUnsupported
		}
		return []string{c}, nil
	case ApplyPolicy:
		c := defaultDenyCmd(st.Tool)
		if c == "" {
			return nil, ErrEditUnsupported
		}
		return []string{c}, nil
	case ApplyBulk:
		var cmds []string
		idxs := append([]int(nil), req.Indexes...)
		for i := range idxs {
			for j := i + 1; j < len(idxs); j++ {
				if idxs[j] > idxs[i] {
					idxs[i], idxs[j] = idxs[j], idxs[i]
				}
			}
		}
		for _, idx := range idxs {
			if c := buildDelete(st.Tool, idx); c != "" {
				cmds = append(cmds, c)
			}
		}
		return cmds, nil
	default:
		return nil, ErrBadArg
	}
}

func (m *Manager) insertCmd(tool Tool, rules []Rule, at int, spec RuleSpec) string {
	switch tool {
	case ToolUFW:
		return "ufw insert " + strconv.Itoa(at) + " " + ufwRuleBody(spec)
	case ToolIPTables:
		return "iptables -I INPUT " + strconv.Itoa(at) + " " + iptRuleBody(spec)
	case ToolNftables:
		return nftInsertCmd(rules, "input", at, spec)
	}
	return ""
}

func (m *Manager) runCmds(ctx context.Context, l *nodeAndCred, cmds []string) error {
	for _, c := range cmds {
		wrapped := fmt.Sprintf("sudo -n sh -c %s 2>&1 || sh -c %s 2>&1", shellQuote(c), shellQuote(c))
		if _, err := m.runFW(ctx, l, wrapped, "apply", m.cfg.SSHTimeout); err != nil {
			return err
		}
	}
	return nil
}
