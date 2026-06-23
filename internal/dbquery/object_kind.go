package dbquery

import (
	"encoding/json"
	"fmt"
	"strings"
)

// ObjectKindSet is a bitmask of database object categories an adapter's
// designer can render. Empty set => no object designer support.
type ObjectKindSet uint32

const (
	KindTable ObjectKindSet = 1 << iota
	KindView
	KindFunction
	KindProcedure
	KindTrigger
	KindEvent
	KindIndex
	KindSequence
)

var kindNames = []struct {
	bit  ObjectKindSet
	name string
}{
	{KindTable, "table"},
	{KindView, "view"},
	{KindFunction, "function"},
	{KindProcedure, "procedure"},
	{KindTrigger, "trigger"},
	{KindEvent, "event"},
	{KindIndex, "index"},
	{KindSequence, "sequence"},
}

// Has reports whether the kind bit is present.
func (s ObjectKindSet) Has(kind ObjectKindSet) bool { return s&kind != 0 }

// String returns a comma-separated lowercase list of kinds, in canonical order.
func (s ObjectKindSet) String() string {
	parts := make([]string, 0, len(kindNames))
	for _, k := range kindNames {
		if s&k.bit != 0 {
			parts = append(parts, k.name)
		}
	}
	return strings.Join(parts, ",")
}

// MarshalJSON emits the canonical CSV form so the wire format matches the
// documented contract: "object_designer": "table,view,index". Without this
// hook encoding/json ignores String() and emits the raw uint32 (7).
func (s ObjectKindSet) MarshalJSON() ([]byte, error) {
	return json.Marshal(s.String())
}

// UnmarshalJSON parses the CSV form back into the bitmask. Empty string and
// null decode to the zero set. Unknown kind names produce an error so
// silently dropping bits cannot happen.
func (s *ObjectKindSet) UnmarshalJSON(data []byte) error {
	if len(data) == 0 || string(data) == "null" {
		*s = 0
		return nil
	}
	var raw string
	if err := json.Unmarshal(data, &raw); err != nil {
		return fmt.Errorf("ObjectKindSet: expected JSON string, got %s", data)
	}
	if raw == "" {
		*s = 0
		return nil
	}
	var out ObjectKindSet
	for _, part := range strings.Split(raw, ",") {
		name := strings.TrimSpace(part)
		var bit ObjectKindSet
		for _, k := range kindNames {
			if k.name == name {
				bit = k.bit
				break
			}
		}
		if bit == 0 {
			return fmt.Errorf("ObjectKindSet: unknown kind %q", name)
		}
		out |= bit
	}
	*s = out
	return nil
}
