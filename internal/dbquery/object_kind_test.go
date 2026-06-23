package dbquery

import "testing"

func TestObjectKindSetHas(t *testing.T) {
	set := KindTable | KindIndex
	if !set.Has(KindTable) {
		t.Fatal("expected Has(KindTable) == true")
	}
	if set.Has(KindView) {
		t.Fatal("expected Has(KindView) == false")
	}
}

func TestObjectKindSetString(t *testing.T) {
	set := KindTable | KindView | KindFunction
	got := set.String()
	want := "table,view,function"
	if got != want {
		t.Fatalf("got %q want %q", got, want)
	}
	if (ObjectKindSet(0)).String() != "" {
		t.Fatal("zero set should stringify empty")
	}
}
