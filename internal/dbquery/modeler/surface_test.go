package modeler

import "testing"

func TestExportedSurface(t *testing.T) {
	var _ Modeler
	var _ Model
	var _ Relation
	var _ RelationEnd
	var _ Layout
	var _ Point
	var _ Size
	var _ DiffResult
}
