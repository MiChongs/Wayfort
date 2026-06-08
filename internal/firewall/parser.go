package firewall

import (
	"encoding/json"
	"regexp"
	"strconv"
	"strings"
)

// detectTool inspects the keyed output of the detection probe and returns
// the first available tool in priority order ufw → firewalld → nft →
// iptables. The probe must emit `<key>=<path>` lines so leading/trailing
// blank lines don't break positional indexing.
//
// nft sits above iptables because modern Linux distributions (Debian 11+,
// Fedora 32+, RHEL 9+) default to nftables as the kernel-side backend;
// `iptables` is just a translation shim there. Detecting nft lets us read
// the real rules rather than the legacy view.
func detectTool(probeOutput string) Tool {
	paths := map[string]string{}
	for _, line := range strings.Split(probeOutput, "\n") {
		k, v, ok := strings.Cut(strings.TrimSpace(line), "=")
		if !ok {
			continue
		}
		paths[k] = strings.TrimSpace(v)
	}
	if paths["ufw"] != "" {
		return ToolUFW
	}
	if paths["firewalld"] != "" {
		return ToolFirewalld
	}
	if paths["nft"] != "" {
		return ToolNftables
	}
	if paths["iptables"] != "" {
		return ToolIPTables
	}
	return ToolUnsupported
}

// parseUFWStatus parses `ufw status verbose` output. Format example:
//
//	Status: active
//	Logging: on (low)
//	Default: deny (incoming), allow (outgoing), disabled (routed)
//	New profiles: skip
//
//	To                         Action      From
//	--                         ------      ----
//	22/tcp                     ALLOW IN    Anywhere
//	80,443/tcp                 ALLOW IN    Anywhere
func parseUFWStatus(out string) (Status, []Rule) {
	s := Status{Tool: ToolUFW}
	lines := strings.Split(out, "\n")
	rules := make([]Rule, 0, 8)
	inRules := false
	idx := 0
	for _, raw := range lines {
		line := strings.TrimSpace(raw)
		if line == "" {
			continue
		}
		if strings.HasPrefix(line, "Status:") {
			s.Active = strings.Contains(strings.ToLower(line), "active")
			continue
		}
		if strings.HasPrefix(line, "Default:") {
			s.Policy = strings.TrimSpace(strings.TrimPrefix(line, "Default:"))
			continue
		}
		if strings.HasPrefix(line, "To") && strings.Contains(line, "Action") {
			inRules = true
			continue
		}
		if !inRules || strings.HasPrefix(line, "--") {
			continue
		}
		idx++
		r := parseUFWRule(raw, idx)
		rules = append(rules, r)
	}
	s.RuleCount = len(rules)
	return s, rules
}

// parseUFWRule treats the line as `To Action Direction From [From...]`.
// UFW pads columns with variable whitespace (`ALLOW IN` vs `DENY  IN`),
// so we use Fields and recover columns positionally rather than try to
// detect column boundaries.
func parseUFWRule(raw string, index int) Rule {
	r := Rule{Index: index, Raw: strings.TrimSpace(raw)}
	fields := strings.Fields(r.Raw)
	if len(fields) < 4 {
		return r
	}
	port, proto := splitPortProto(fields[0])
	r.Port = port
	r.Protocol = proto
	r.Action = strings.ToUpper(fields[1])
	r.Direction = strings.ToLower(fields[2])
	r.Source = strings.Join(fields[3:], " ")
	return r
}

// "22/tcp" → ("22", "tcp"); "80,443/tcp" → ("80,443", "tcp"); "Anywhere" → ("", "").
func splitPortProto(s string) (string, string) {
	s = strings.TrimSpace(s)
	if s == "" || strings.EqualFold(s, "Anywhere") {
		return "", ""
	}
	if i := strings.LastIndex(s, "/"); i >= 0 {
		return s[:i], strings.ToLower(s[i+1:])
	}
	return s, ""
}

// parseFirewalldList parses `firewall-cmd --list-all` output. Example:
//
//	public (active)
//	  target: default
//	  ...
//	  services: ssh dhcpv6-client
//	  ports: 80/tcp 443/tcp
//	  sources: 10.0.0.0/8
//
// Each port and each service+source combo becomes a Rule. Service names are
// translated to ports where possible (best-effort; falls back to service
// label in Port).
func parseFirewalldList(out string) (Status, []Rule) {
	s := Status{Tool: ToolFirewalld}
	s.Active = strings.Contains(out, "(active)") || strings.Contains(out, "running")
	rules := make([]Rule, 0, 8)
	idx := 0
	var sources []string
	for _, raw := range strings.Split(out, "\n") {
		line := strings.TrimSpace(raw)
		key, value, ok := strings.Cut(line, ":")
		if !ok {
			continue
		}
		key = strings.TrimSpace(key)
		value = strings.TrimSpace(value)
		switch key {
		case "target":
			s.Policy = value
		case "sources":
			sources = strings.Fields(value)
		case "services":
			for _, svc := range strings.Fields(value) {
				idx++
				rules = append(rules, Rule{
					Index:     idx,
					Action:    "ALLOW",
					Direction: "in",
					Port:      svc, // firewalld services don't map to ports cheaply; show name
					Source:    joinSources(sources),
					Raw:       "service=" + svc,
				})
			}
		case "ports":
			for _, pp := range strings.Fields(value) {
				port, proto := splitPortProto(pp)
				idx++
				rules = append(rules, Rule{
					Index:     idx,
					Action:    "ALLOW",
					Direction: "in",
					Protocol:  proto,
					Port:      port,
					Source:    joinSources(sources),
					Raw:       pp,
				})
			}
		}
	}
	s.RuleCount = len(rules)
	return s, rules
}

func joinSources(srcs []string) string {
	if len(srcs) == 0 {
		return "Anywhere"
	}
	return strings.Join(srcs, ",")
}

// parseIPTablesList parses `iptables -L <chain> -n -v --line-numbers` output
// (or the same for ip6tables). The chain + family arguments are stamped onto
// each Rule so callers can fan out to INPUT/FORWARD/OUTPUT × v4/v6 and
// merge results into one slice without losing identity.
//
//	Chain INPUT (policy DROP 0 packets, 0 bytes)
//	num   pkts bytes target     prot opt in   out  source       destination
//	1      12   720 ACCEPT     tcp  --  *    *    0.0.0.0/0    0.0.0.0/0    tcp dpt:22
//	2       0     0 DROP       all  --  *    *    10.0.0.0/8   0.0.0.0/0
var iptablesPolicyRE = regexp.MustCompile(`policy\s+([A-Z]+)`)

func parseIPTablesList(out, chain string, family Family) (Status, []Rule) {
	s := Status{Tool: ToolIPTables, Active: true}
	if m := iptablesPolicyRE.FindStringSubmatch(out); m != nil && chain == "INPUT" {
		// Only the INPUT chain's policy is meaningful as a coarse summary.
		s.Policy = m[1]
	}
	rules := make([]Rule, 0, 8)
	for _, raw := range strings.Split(out, "\n") {
		fields := strings.Fields(raw)
		if len(fields) < 9 {
			continue
		}
		if _, err := strconv.Atoi(fields[0]); err != nil {
			continue
		}
		idx, _ := strconv.Atoi(fields[0])
		r := Rule{
			Index:     idx,
			Action:    fields[3],
			Direction: directionForChain(chain),
			Protocol:  fields[4],
			Source:    fields[7],
			Chain:     chain,
			Family:    family,
			Pkts:      parseCount(fields[1]),
			Bytes:     parseCount(fields[2]),
			Raw:       strings.TrimSpace(raw),
		}
		if r.Protocol == "all" {
			r.Protocol = "any"
		}
		for _, tok := range fields[9:] {
			if strings.HasPrefix(tok, "dpt:") {
				r.Port = strings.TrimPrefix(tok, "dpt:")
				break
			}
			if strings.HasPrefix(tok, "dpts:") {
				r.Port = strings.TrimPrefix(tok, "dpts:")
				break
			}
		}
		rules = append(rules, r)
	}
	s.RuleCount = len(rules)
	return s, rules
}

func directionForChain(chain string) string {
	switch strings.ToUpper(chain) {
	case "OUTPUT":
		return "out"
	default:
		return "in"
	}
}

// nftRuleset is the top-level shape of `nft -j list ruleset` — one big
// envelope with a heterogenous array of metaobjects (tables, chains,
// rules). We only need the rules.
type nftRuleset struct {
	Nftables []nftItem `json:"nftables"`
}

type nftItem struct {
	Rule *nftRule `json:"rule,omitempty"`
}

type nftRule struct {
	Family string         `json:"family"`            // inet | ip | ip6 | arp | bridge
	Table  string         `json:"table"`
	Chain  string         `json:"chain"`
	Handle int            `json:"handle"`
	Expr   []nftExprEntry `json:"expr"`
	Comment string        `json:"comment,omitempty"`
}

// Each entry in expr is a single-key object. We don't model every
// possibility — just the ones we surface on the UI. Anything else stays in
// Rule.Raw via JSON re-encoding so the operator can still see what the
// rule actually does.
type nftExprEntry map[string]json.RawMessage

// parseNftables takes the stdout of `nft -j list ruleset` and emits one
// Rule per concrete rule, family-tagged. Tables / chains / sets / maps are
// ignored. Returns an error on malformed JSON; the manager wraps that as
// ErrParse so the operator sees a real diagnosis instead of a silently
// empty rule list.
func parseNftables(out string) (Status, []Rule, error) {
	s := Status{Tool: ToolNftables, Active: true}
	out = strings.TrimSpace(out)
	if out == "" {
		return s, nil, nil
	}
	var rs nftRuleset
	if err := json.Unmarshal([]byte(out), &rs); err != nil {
		return s, nil, err
	}
	rules := make([]Rule, 0, 8)
	for _, it := range rs.Nftables {
		if it.Rule == nil {
			continue
		}
		r := nftRuleToUnified(it.Rule)
		rules = append(rules, r)
	}
	s.RuleCount = len(rules)
	return s, rules, nil
}

func nftRuleToUnified(n *nftRule) Rule {
	h := n.Handle
	r := Rule{
		Index:     n.Handle,
		Handle:    &h,
		Table:     n.Table,
		Chain:     n.Chain,
		Direction: directionForChain(n.Chain),
		Family:    nftFamily(n.Family),
		Comment:   n.Comment,
		Raw:       reencodeExpr(n),
	}
	for _, e := range n.Expr {
		// Terminal verdicts.
		if _, ok := e["accept"]; ok {
			r.Action = "ALLOW"
		} else if _, ok := e["drop"]; ok {
			r.Action = "DENY"
		} else if _, ok := e["reject"]; ok {
			r.Action = "REJECT"
		} else if v, ok := e["match"]; ok {
			// "match": { "op": "==", "left": {...}, "right": ... }
			parseNftMatch(v, &r)
		} else if v, ok := e["counter"]; ok {
			parseNftCounter(v, &r)
		}
	}
	if r.Action == "" {
		r.Action = "(no terminal verdict)"
	}
	return r
}

// parseNftCounter extracts {"counter":{"packets":N,"bytes":M}} into the rule.
func parseNftCounter(raw json.RawMessage, r *Rule) {
	var c struct {
		Packets int64 `json:"packets"`
		Bytes   int64 `json:"bytes"`
	}
	if err := json.Unmarshal(raw, &c); err == nil {
		r.Pkts = c.Packets
		r.Bytes = c.Bytes
	}
}

func nftFamily(f string) Family {
	switch f {
	case "ip", "inet":
		return FamilyV4
	case "ip6":
		return FamilyV6
	default:
		return FamilyAny
	}
}

func parseNftMatch(raw json.RawMessage, r *Rule) {
	var m struct {
		Left  json.RawMessage `json:"left"`
		Right json.RawMessage `json:"right"`
	}
	if err := json.Unmarshal(raw, &m); err != nil {
		return
	}
	// `left` shape we care about:
	//   {"payload": {"protocol": "tcp", "field": "dport"}}
	//   {"payload": {"protocol": "ip", "field": "saddr"}}
	var leftWrap struct {
		Payload *struct {
			Protocol string `json:"protocol"`
			Field    string `json:"field"`
		} `json:"payload"`
	}
	if err := json.Unmarshal(m.Left, &leftWrap); err != nil || leftWrap.Payload == nil {
		return
	}
	switch leftWrap.Payload.Field {
	case "dport":
		r.Protocol = leftWrap.Payload.Protocol
		// right may be a number or a {set:[...]} — try number first.
		var num int
		if err := json.Unmarshal(m.Right, &num); err == nil && num > 0 {
			r.Port = strconv.Itoa(num)
			return
		}
		// fallback: dump the raw JSON of the set
		r.Port = strings.Trim(string(m.Right), `"`)
	case "saddr":
		// right is a string CIDR
		var s string
		if err := json.Unmarshal(m.Right, &s); err == nil {
			r.Source = s
		}
	}
}

func reencodeExpr(n *nftRule) string {
	b, err := json.Marshal(n.Expr)
	if err != nil {
		return ""
	}
	out := string(b)
	if len(out) > 200 {
		out = out[:200] + "…"
	}
	return out
}

// buildUFWAdd returns the shell command that adds a rule via ufw.
func buildUFWAdd(spec RuleSpec) string {
	action := strings.ToLower(spec.Action)
	dir := spec.Direction
	if dir == "" {
		dir = "in"
	}
	proto := spec.Protocol
	if proto == "" {
		proto = "tcp"
	}
	src := spec.Source
	if src == "" {
		src = "any"
	}
	return "ufw " + action + " " + dir + " proto " + proto +
		" from " + src + " to any port " + spec.Port
}

// buildFirewalldAdd returns the command that adds a permanent rule + reloads.
func buildFirewalldAdd(spec RuleSpec) string {
	proto := spec.Protocol
	if proto == "" {
		proto = "tcp"
	}
	return "firewall-cmd --permanent --add-port=" + spec.Port + "/" + proto +
		" && firewall-cmd --reload"
}

// buildIPTablesAdd: appends a rule to INPUT.
func buildIPTablesAdd(spec RuleSpec) string {
	target := "ACCEPT"
	switch strings.ToUpper(spec.Action) {
	case "DENY":
		target = "DROP"
	case "REJECT":
		target = "REJECT"
	}
	proto := spec.Protocol
	if proto == "" {
		proto = "tcp"
	}
	cmd := "iptables -A INPUT -p " + proto + " --dport " + spec.Port + " -j " + target
	if spec.Source != "" && spec.Source != "any" {
		cmd = "iptables -A INPUT -s " + spec.Source + " -p " + proto + " --dport " + spec.Port + " -j " + target
	}
	return cmd
}

// buildNftablesAdd: appends a rule to the inet/filter input chain. nft is
// picky about syntax; we use the canonical `add rule inet filter input ...`
// form which works on every nft 0.9+ install.
func buildNftablesAdd(spec RuleSpec) string {
	verdict := "accept"
	switch strings.ToUpper(spec.Action) {
	case "DENY":
		verdict = "drop"
	case "REJECT":
		verdict = "reject"
	}
	proto := spec.Protocol
	if proto == "" {
		proto = "tcp"
	}
	parts := []string{"nft", "add", "rule", "inet", "filter", "input"}
	if spec.Source != "" && spec.Source != "any" {
		parts = append(parts, "ip", "saddr", spec.Source)
	}
	parts = append(parts, proto, "dport", spec.Port, verdict)
	return strings.Join(parts, " ")
}

// buildDelete returns the command that removes rule N by index. For nft
// the "index" is the rule handle as emitted by `nft -a list ruleset`.
func buildDelete(tool Tool, index int) string {
	switch tool {
	case ToolUFW:
		return "ufw --force delete " + strconv.Itoa(index)
	case ToolIPTables:
		return "iptables -D INPUT " + strconv.Itoa(index)
	case ToolNftables:
		// "delete rule inet filter <chain> handle N" — chain defaults to
		// input because that's where the unified frontend lets you add
		// rules. Cross-chain delete is left to manual ops.
		return "nft delete rule inet filter input handle " + strconv.Itoa(index)
	default:
		return "" // firewalld doesn't support positional delete; handled separately
	}
}
