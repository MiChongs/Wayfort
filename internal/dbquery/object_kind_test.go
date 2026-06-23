package dbquery

import (
	"encoding/json"
	"testing"
)

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

func TestObjectKindSetJSONRoundTrip(t *testing.T) {
	cases := []struct {
		name string
		set  ObjectKindSet
		want string
	}{
		{"empty", 0, `""`},
		{"single", KindTable, `"table"`},
		{"multiple", KindTable | KindView | KindFunction, `"table,view,function"`},
		{"all", KindTable | KindView | KindFunction | KindProcedure | KindTrigger | KindEvent | KindIndex | KindSequence, `"table,view,function,procedure,trigger,event,index,sequence"`},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			b, err := json.Marshal(c.set)
			if err != nil {
				t.Fatalf("marshal: %v", err)
			}
			if string(b) != c.want {
				t.Fatalf("marshal: got %s want %s", b, c.want)
			}
			var back ObjectKindSet
			if err := json.Unmarshal(b, &back); err != nil {
				t.Fatalf("unmarshal: %v", err)
			}
			if back != c.set {
				t.Fatalf("round-trip: got %v want %v", back, c.set)
			}
		})
	}
}

func TestObjectKindSetUnmarshalUnknown(t *testing.T) {
	var s ObjectKindSet
	if err := json.Unmarshal([]byte(`"table,bogus"`), &s); err == nil {
		t.Fatal("expected error on unknown kind")
	}
}
