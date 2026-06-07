package webssh

import (
	"reflect"
	"testing"
)

func collect(chunks ...string) []string {
	var got []string
	t := newCmdTracker(func(cmd string) { got = append(got, cmd) })
	for _, c := range chunks {
		t.feed(c)
	}
	return got
}

func TestCmdTracker(t *testing.T) {
	cases := []struct {
		name   string
		chunks []string
		want   []string
	}{
		{"simple", []string{"ls -la\r"}, []string{"ls -la"}},
		{"split across feeds", []string{"who", "ami\r"}, []string{"whoami"}},
		{"newline variant", []string{"pwd\n"}, []string{"pwd"}},
		{"backspace edits", []string{"lss\x7f -l\r"}, []string{"ls -l"}},
		{"ctrl-c abandons line", []string{"rm -rf /\x03ls\r"}, []string{"ls"}},
		{"empty lines dropped", []string{"\r\r   \r"}, nil},
		{"two commands one chunk", []string{"a\rb\r"}, []string{"a", "b"}},
		{"trims surrounding space", []string{"  echo hi  \r"}, []string{"echo hi"}},
		{"escape sequence swallowed", []string{"ls\x1b[D\r"}, []string{"ls"}},
		{"unterminated line not emitted", []string{"sudo reboot"}, nil},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			got := collect(c.chunks...)
			if !reflect.DeepEqual(got, c.want) {
				t.Fatalf("got %#v, want %#v", got, c.want)
			}
		})
	}
}
