package firewall

import (
	"context"
	"fmt"
	"strconv"
	"strings"

	"github.com/michongs/jumpserver-anonymous/internal/model"
)

// edit.go makes ufw + nftables first-class: insert-at-position, in-place edit,
// reorder, and persistence. iptables gets insert/edit/move via -I/-R/-D too;
// firewalld (no positional model) returns ErrEditUnsupported. nft edits assume
// the standard `inet filter` table (what our AddRule creates); rules in other
// tables are left to manual ops.

// InsertRule inserts a rule at a 1-based position. Gated by firewall:manage.
func (m *Manager) InsertRule(ctx context.Context, userID, nodeID uint64, claims AuditClaims, ins RuleInsert) error {
	l, err := m.gateAndLoad(ctx, userID, nodeID)
	if err != nil {
		return err
	}
	if err := sanitizeSpec(&ins.Spec); err != nil {
		return err
	}
	if !validIndex(ins.At) {
		return ErrBadArg
	}
	status, rules, err := m.snapshot(ctx, userID, nodeID)
	if err != nil {
		return err
	}
	var cmd string
	switch status.Tool {
	case ToolUFW:
		cmd = "ufw insert " + strconv.Itoa(ins.At) + " " + ufwRuleBody(ins.Spec)
	case ToolIPTables:
		cmd = "iptables -I INPUT " + strconv.Itoa(ins.At) + " " + iptRuleBody(ins.Spec)
	case ToolNftables:
		cmd = nftInsertCmd(rules, "input", ins.At, ins.Spec)
	default:
		return ErrEditUnsupported
	}
	if err := m.runWrite(ctx, l, nodeID, claims, status.Tool, cmd, "insert"); err != nil {
		return err
	}
	return nil
}

// EditRule replaces an existing rule in place (ufw/iptables = delete+reinsert at
// same index; nft = replace by handle). Gated by firewall:manage.
func (m *Manager) EditRule(ctx context.Context, userID, nodeID uint64, claims AuditClaims, ed RuleEdit) error {
	l, err := m.gateAndLoad(ctx, userID, nodeID)
	if err != nil {
		return err
	}
	if err := sanitizeSpec(&ed.NewSpec); err != nil {
		return err
	}
	status, _, err := m.snapshot(ctx, userID, nodeID)
	if err != nil {
		return err
	}
	var cmd string
	switch status.Tool {
	case ToolUFW:
		if !validIndex(ed.Index) {
			return ErrBadArg
		}
		n := strconv.Itoa(ed.Index)
		cmd = "ufw --force delete " + n + " && ufw insert " + n + " " + ufwRuleBody(ed.NewSpec)
	case ToolIPTables:
		if !validIndex(ed.Index) {
			return ErrBadArg
		}
		cmd = "iptables -R INPUT " + strconv.Itoa(ed.Index) + " " + iptRuleBody(ed.NewSpec)
	case ToolNftables:
		if ed.Handle == nil || !validHandle(*ed.Handle) {
			return ErrBadArg
		}
		chain := nftChain(ed.Chain)
		cmd = fmt.Sprintf("nft replace rule inet filter %s handle %d %s counter %s",
			chain, *ed.Handle, nftMatchers(ed.NewSpec), nftVerdict(ed.NewSpec.Action))
	default:
		return ErrEditUnsupported
	}
	if err := m.runWrite(ctx, l, nodeID, claims, status.Tool, cmd, "edit"); err != nil {
		return err
	}
	return nil
}

// MoveRule reorders a rule to a new 1-based position. Gated by firewall:manage.
func (m *Manager) MoveRule(ctx context.Context, userID, nodeID uint64, claims AuditClaims, mv RuleMove) error {
	l, err := m.gateAndLoad(ctx, userID, nodeID)
	if err != nil {
		return err
	}
	status, rules, err := m.snapshot(ctx, userID, nodeID)
	if err != nil {
		return err
	}
	var cmd string
	switch status.Tool {
	case ToolUFW:
		if !validIndex(mv.From) || !validIndex(mv.To) {
			return ErrBadArg
		}
		r := ruleByIndex(rules, mv.From)
		if r == nil {
			return ErrBadArg
		}
		to := mv.To
		if mv.To > mv.From { // deleting From shifts everything after it up by one
			to = mv.To - 1
		}
		if to < 1 {
			to = 1
		}
		cmd = "ufw --force delete " + strconv.Itoa(mv.From) + " && ufw insert " + strconv.Itoa(to) + " " + ufwRuleBody(ruleToSpec(*r))
	case ToolIPTables:
		if !validIndex(mv.From) || !validIndex(mv.To) {
			return ErrBadArg
		}
		r := ruleByIndex(rules, mv.From)
		if r == nil {
			return ErrBadArg
		}
		to := mv.To
		if mv.To > mv.From {
			to = mv.To - 1
		}
		if to < 1 {
			to = 1
		}
		cmd = fmt.Sprintf("iptables -D INPUT %d && iptables -I INPUT %d %s", mv.From, to, iptRuleBody(ruleToSpec(*r)))
	case ToolNftables:
		if mv.Handle == nil || !validHandle(*mv.Handle) {
			return ErrBadArg
		}
		r := ruleByHandle(rules, *mv.Handle)
		if r == nil {
			return ErrBadArg
		}
		chain := nftChain(mv.Chain)
		// delete the rule then re-insert at the target position's handle
		del := fmt.Sprintf("nft delete rule inet filter %s handle %d", chain, *mv.Handle)
		ins := nftInsertCmd(rules, chain, mv.To, ruleToSpec(*r))
		cmd = del + " && " + ins
	default:
		return ErrEditUnsupported
	}
	if err := m.runWrite(ctx, l, nodeID, claims, status.Tool, cmd, "move"); err != nil {
		return err
	}
	return nil
}

// BulkDelete removes several rules. Positional tools (ufw/iptables) delete from
// the highest index down so earlier indexes stay valid. Returns the count.
func (m *Manager) BulkDelete(ctx context.Context, userID, nodeID uint64, claims AuditClaims, indexes []int) (int, error) {
	if len(indexes) == 0 {
		return 0, nil
	}
	// descending order
	sorted := append([]int(nil), indexes...)
	for i := 0; i < len(sorted); i++ {
		for j := i + 1; j < len(sorted); j++ {
			if sorted[j] > sorted[i] {
				sorted[i], sorted[j] = sorted[j], sorted[i]
			}
		}
	}
	n := 0
	for _, idx := range sorted {
		if err := m.DeleteRule(ctx, userID, nodeID, claims, idx); err != nil {
			return n, err
		}
		n++
	}
	return n, nil
}

// Persist writes the live ruleset to disk so it survives reboot (nft/iptables;
// ufw is already persistent). Gated by firewall:manage.
func (m *Manager) Persist(ctx context.Context, userID, nodeID uint64, claims AuditClaims) error {
	l, err := m.gateAndLoad(ctx, userID, nodeID)
	if err != nil {
		return err
	}
	status, _, err := m.snapshot(ctx, userID, nodeID)
	if err != nil {
		return err
	}
	switch status.Tool {
	case ToolNftables:
		if err := m.persistNft(ctx, l); err != nil {
			return err
		}
	case ToolIPTables:
		if err := m.persistIptables(ctx, l); err != nil {
			return err
		}
	}
	m.recordAudit(claims, nodeID, model.AuditFirewallChange, "persist "+string(status.Tool))
	return nil
}

// runWrite executes a mutation command, then persists (nft/iptables), bumps the
// cache, and audits.
func (m *Manager) runWrite(ctx context.Context, l *nodeAndCred, nodeID uint64, claims AuditClaims, tool Tool, cmd, op string) error {
	wrapped := fmt.Sprintf("sudo -n sh -c %s 2>&1 || sh -c %s 2>&1", shellQuote(cmd), shellQuote(cmd))
	if _, err := m.runFW(ctx, l, wrapped, "firewall "+op, m.cfg.SSHTimeout); err != nil {
		return err
	}
	switch tool {
	case ToolNftables:
		_ = m.persistNft(ctx, l)
	case ToolIPTables:
		_ = m.persistIptables(ctx, l)
	}
	m.invalidate(nodeID)
	m.recordAudit(claims, nodeID, model.AuditFirewallChange, op+" "+cmd)
	return nil
}

func (m *Manager) persistNft(ctx context.Context, l *nodeAndCred) error {
	inner := `nft list ruleset > /etc/nftables.conf 2>/dev/null || nft list ruleset > /etc/sysconfig/nftables.conf 2>/dev/null; command -v systemctl >/dev/null 2>&1 && systemctl enable nftables >/dev/null 2>&1; :`
	cmd := fmt.Sprintf("sudo -n sh -c %s 2>&1 || sh -c %s 2>&1", shellQuote(inner), shellQuote(inner))
	_, err := m.runFW(ctx, l, cmd, "persist nft", m.cfg.SSHTimeout)
	return err
}

func (m *Manager) persistIptables(ctx context.Context, l *nodeAndCred) error {
	inner := `(iptables-save > /etc/iptables/rules.v4 2>/dev/null) || (netfilter-persistent save 2>/dev/null) || (service iptables save 2>/dev/null) || true; (ip6tables-save > /etc/iptables/rules.v6 2>/dev/null) || true`
	cmd := fmt.Sprintf("sudo -n sh -c %s 2>&1 || sh -c %s 2>&1", shellQuote(inner), shellQuote(inner))
	_, err := m.runFW(ctx, l, cmd, "persist iptables", m.cfg.SSHTimeout)
	return err
}

// ---- rule body builders (sanitized spec → shell-safe command fragment) ----

func ufwRuleBody(s RuleSpec) string {
	src := s.Source
	if src == "" || isAnywhereSource(src) {
		src = "any"
	}
	return fmt.Sprintf("%s %s proto %s from %s to any port %s",
		strings.ToLower(s.Action), s.Direction, s.Protocol, shellQuote(src), shellQuote(s.Port))
}

func iptRuleBody(s RuleSpec) string {
	target := "ACCEPT"
	switch s.Action {
	case "DENY":
		target = "DROP"
	case "REJECT":
		target = "REJECT"
	}
	parts := []string{"-p", s.Protocol}
	if s.Source != "" && !isAnywhereSource(s.Source) {
		parts = append([]string{"-s", shellQuote(s.Source)}, parts...)
	}
	if s.Port != "" {
		parts = append(parts, "--dport", shellQuote(s.Port))
	}
	parts = append(parts, "-j", target)
	return strings.Join(parts, " ")
}

func nftMatchers(s RuleSpec) string {
	var parts []string
	if s.Source != "" && !isAnywhereSource(s.Source) {
		fam := "ip"
		if strings.Contains(s.Source, ":") {
			fam = "ip6"
		}
		parts = append(parts, fam, "saddr", shellQuote(s.Source))
	}
	switch s.Protocol {
	case "tcp", "udp":
		parts = append(parts, s.Protocol, "dport", shellQuote(s.Port))
	case "icmp":
		parts = append(parts, "ip", "protocol", "icmp")
	}
	return strings.Join(parts, " ")
}

func nftVerdict(action string) string {
	switch action {
	case "DENY":
		return "drop"
	case "REJECT":
		return "reject"
	default:
		return "accept"
	}
}

func nftChain(c string) string {
	c = strings.ToLower(strings.TrimSpace(c))
	switch c {
	case "input", "forward", "output":
		return c
	default:
		return "input"
	}
}

// nftInsertCmd builds an insert at a 1-based position within a chain, using the
// handle of the rule currently at that position (`nft insert ... position H`).
// Past the end it appends.
func nftInsertCmd(rules []Rule, chain string, at int, spec RuleSpec) string {
	body := nftMatchers(spec) + " counter " + nftVerdict(spec.Action)
	pos := 0
	count := 0
	for _, r := range rules {
		if strings.EqualFold(r.Chain, chain) && (r.Table == "filter" || r.Table == "") {
			count++
			if count == at && r.Handle != nil {
				pos = *r.Handle
				break
			}
		}
	}
	if pos > 0 {
		return fmt.Sprintf("nft insert rule inet filter %s position %d %s", chain, pos, body)
	}
	return fmt.Sprintf("nft add rule inet filter %s %s", chain, body)
}

// ---- rule lookups ----

func ruleByIndex(rules []Rule, idx int) *Rule {
	for i := range rules {
		if rules[i].Index == idx {
			return &rules[i]
		}
	}
	return nil
}
func ruleByHandle(rules []Rule, h int) *Rule {
	for i := range rules {
		if rules[i].Handle != nil && *rules[i].Handle == h {
			return &rules[i]
		}
	}
	return nil
}
func ruleToSpec(r Rule) RuleSpec {
	src := r.Source
	if isAnywhereSource(src) {
		src = ""
	}
	proto := r.Protocol
	if proto == "any" {
		proto = ""
	}
	return RuleSpec{Action: strings.ToUpper(r.Action), Direction: r.Direction, Protocol: proto, Port: r.Port, Source: src}
}
