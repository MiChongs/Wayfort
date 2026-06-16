package accesscontrol

import (
	"encoding/json"
	"strings"
)

// methodSpec is the parsed AccessRule.Spec for a connection_method rule: the set
// of connection methods (protocols) the rule applies to. Empty/absent ⇒ the rule
// applies to ALL methods.
type methodSpec struct {
	Methods []string `json:"methods"`
}

// methodMatches reports whether the requested protocol falls under the rule's
// connection-method set. Case-insensitive; an empty set matches every method.
func methodMatches(spec, protocol string) bool {
	spec = strings.TrimSpace(spec)
	if spec == "" {
		return true
	}
	var s methodSpec
	if err := json.Unmarshal([]byte(spec), &s); err != nil || len(s.Methods) == 0 {
		return true
	}
	for _, m := range s.Methods {
		if strings.EqualFold(strings.TrimSpace(m), protocol) {
			return true
		}
	}
	return false
}
