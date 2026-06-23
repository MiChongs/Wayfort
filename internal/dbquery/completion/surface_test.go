package completion

import "testing"

func TestExportedSurface(t *testing.T) {
	var _ Provider
	var _ Snapshot
	var _ TableEntry
	var _ ColumnEntry
	var _ FunctionEntry
}
