package firewall

import (
	"regexp"
	"strconv"
	"strings"
)

// detectTool inspects the keyed output of the detection probe and returns
// the first available tool in priority order ufw → firewalld → iptables.
// The probe must emit `<key>=<path>` lines so leading/trailing blank lines
// don't break positional indexing.
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

// parseIPTablesList parses `iptables -L INPUT -n -v --line-numbers` output.
// Example:
//
//	Chain INPUT (policy DROP 0 packets, 0 bytes)
//	num   pkts bytes target     prot opt in   out  source       destination
//	1      12   720 ACCEPT     tcp  --  *    *    0.0.0.0/0    0.0.0.0/0    tcp dpt:22
//	2       0     0 DROP       all  --  *    *    10.0.0.0/8   0.0.0.0/0
var iptablesPolicyRE = regexp.MustCompile(`policy\s+([A-Z]+)`)

func parseIPTablesList(out string) (Status, []Rule) {
	s := Status{Tool: ToolIPTables, Active: true}
	if m := iptablesPolicyRE.FindStringSubmatch(out); m != nil {
		s.Policy = m[1]
	}
	rules := make([]Rule, 0, 8)
	for _, raw := range strings.Split(out, "\n") {
		fields := strings.Fields(raw)
		if len(fields) < 9 {
			continue
		}
		// Skip headers ("num", "Chain") — first field of a rule row is the
		// numeric line index.
		if _, err := strconv.Atoi(fields[0]); err != nil {
			continue
		}
		idx, _ := strconv.Atoi(fields[0])
		r := Rule{
			Index:     idx,
			Action:    fields[3],
			Direction: "in",
			Protocol:  fields[4],
			Source:    fields[7],
			Raw:       strings.TrimSpace(raw),
		}
		if r.Protocol == "all" {
			r.Protocol = "any"
		}
		// extract `dpt:NN` if present
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

// buildUFWAdd returns the shell command that adds a rule via ufw.
// Examples:
//
//	allow in tcp 22 from any            → ufw allow in proto tcp from any to any port 22
//	deny  in tcp 80 from 10.0.0.0/8     → ufw deny  in proto tcp from 10.0.0.0/8 to any port 80
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
// Format: firewall-cmd --permanent --add-port=NN/proto && firewall-cmd --reload
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

// buildDelete returns the command that removes rule N by index.
func buildDelete(tool Tool, index int) string {
	switch tool {
	case ToolUFW:
		return "ufw --force delete " + strconv.Itoa(index)
	case ToolIPTables:
		return "iptables -D INPUT " + strconv.Itoa(index)
	default:
		return "" // firewalld doesn't support positional delete; handled separately
	}
}
