package designer

import "testing"

func TestNilSafeDesignerIsZeroValue(t *testing.T) {
	var d Designer
	if d != nil {
		t.Fatal("zero-value Designer must be nil interface")
	}
}

func TestTableSpecZeroValid(t *testing.T) {
	var spec TableSpec
	if spec.Name != "" || len(spec.Columns) != 0 {
		t.Fatal("TableSpec zero value must be empty")
	}
}
