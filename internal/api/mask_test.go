package api

import "testing"

func TestMaskEmail(t *testing.T) {
	cases := map[string]string{
		"zhang.wei@corp.com": "z***@corp.com",
		"a@b.com":            "*@b.com",
		"ab@b.com":           "a***@b.com",
		"":                   "",
		"  bob@x.io ":        "b***@x.io",
		"notanemail":         "n***l",
		"张三@corp.com":        "张***@corp.com",
	}
	for in, want := range cases {
		if got := maskEmail(in); got != want {
			t.Errorf("maskEmail(%q) = %q, want %q", in, got, want)
		}
	}
}

func TestMaskPhone(t *testing.T) {
	cases := map[string]string{
		"13812345678": "138****5678",
		"":            "",
		"12":          "**",
		"12345":       "1***5",
		"1234567":     "123****4567",
		" 13800000000 ": "138****0000",
	}
	for in, want := range cases {
		if got := maskPhone(in); got != want {
			t.Errorf("maskPhone(%q) = %q, want %q", in, got, want)
		}
	}
}

func TestMaskGeneric(t *testing.T) {
	cases := map[string]string{
		"alice": "a***e",
		"ab":    "**",
		"a":     "*",
		"":      "",
	}
	for in, want := range cases {
		if got := maskGeneric(in); got != want {
			t.Errorf("maskGeneric(%q) = %q, want %q", in, got, want)
		}
	}
}
