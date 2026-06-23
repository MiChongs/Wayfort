package modeler

import "testing"

func TestRelationZero(t *testing.T) {
	var r Relation
	if r.From.Table != "" {
		t.Fatal("zero relation must be empty")
	}
}
