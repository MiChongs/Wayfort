package desktop

import (
	"path/filepath"
	"strings"
	"testing"
)

// TestSafeJoinContainment is the security property that matters: no user-
// supplied path — including traversal and absolute paths — may resolve outside
// the user's own drive folder.
func TestSafeJoinContainment(t *testing.T) {
	root := filepath.Join(t.TempDir(), "user-1")
	rootAbs, _ := filepath.Abs(root)

	inputs := []string{
		"",
		".",
		"a/b.txt",
		"nested/deep/file.bin",
		"../user-2/secret",
		"../../etc/passwd",
		"a/../../../escape",
		"/etc/passwd",
		"..\\..\\windows\\system32",
		"a\\b\\c.txt",
		"....//....//x",
	}
	for _, in := range inputs {
		got, ok := safeJoin(root, in)
		if !ok {
			continue // rejected outright is also safe
		}
		gotAbs, _ := filepath.Abs(got)
		if gotAbs != rootAbs && !strings.HasPrefix(gotAbs, rootAbs+string(filepath.Separator)) {
			t.Errorf("safeJoin(%q) escaped root: %q not under %q", in, gotAbs, rootAbs)
		}
	}
}

func TestSafeJoinNormalPath(t *testing.T) {
	root := filepath.Join(t.TempDir(), "user-1")
	got, ok := safeJoin(root, "docs/report.pdf")
	if !ok {
		t.Fatal("expected ok for a normal relative path")
	}
	want := filepath.Join(root, "docs", "report.pdf")
	if got != want {
		t.Fatalf("got %q, want %q", got, want)
	}
}
