package dbquery

import "strings"

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
