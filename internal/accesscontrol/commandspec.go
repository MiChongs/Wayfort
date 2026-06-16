package accesscontrol

import (
	"encoding/json"
	"regexp"
	"strings"
)

// commandSpec is the parsed AccessRule.Spec for a command_filter rule: one or
// more command groups, each a multiline set of patterns (regex or literal
// command), mirroring JumpServer v4's command-group model.
type commandSpec struct {
	CommandGroups []commandGroup `json:"command_groups"`
}

type commandGroup struct {
	Type       string `json:"type"` // "regex" | "command" (default "command")
	Content    string `json:"content"`
	IgnoreCase bool   `json:"ignore_case"`
}

// commandMatches reports whether cmd matches the command_filter rule's Spec.
// An empty/absent spec (no command groups) matches EVERY command, so a rule with
// only dimensions still applies. A "regex" group matches if any non-empty line
// (compiled, optionally case-insensitive) matches; a "command" group matches if
// any non-empty line is a case-(in)sensitive substring of the command.
func commandMatches(spec, cmd string) bool {
	spec = strings.TrimSpace(spec)
	if spec == "" {
		return true
	}
	var s commandSpec
	if err := json.Unmarshal([]byte(spec), &s); err != nil || len(s.CommandGroups) == 0 {
		return true
	}
	for _, g := range s.CommandGroups {
		for _, line := range strings.Split(g.Content, "\n") {
			pat := strings.TrimSpace(line)
			if pat == "" {
				continue
			}
			if g.Type == "regex" {
				expr := pat
				if g.IgnoreCase {
					expr = "(?i)" + expr
				}
				if re, err := regexp.Compile(expr); err == nil && re.MatchString(cmd) {
					return true
				}
				continue
			}
			// literal "command" group
			hay, needle := cmd, pat
			if g.IgnoreCase {
				hay, needle = strings.ToLower(cmd), strings.ToLower(pat)
			}
			if strings.Contains(hay, needle) {
				return true
			}
		}
	}
	return false
}
