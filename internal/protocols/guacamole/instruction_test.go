package guacamole

import (
	"bufio"
	"bytes"
	"strings"
	"testing"
)

func TestEncodeBasic(t *testing.T) {
	var buf bytes.Buffer
	if err := Encode(&buf, "select", "rdp"); err != nil {
		t.Fatal(err)
	}
	got := buf.String()
	want := "6.select,3.rdp;"
	if got != want {
		t.Fatalf("want %q got %q", want, got)
	}
}

func TestEncodeMultiArg(t *testing.T) {
	var buf bytes.Buffer
	if err := Encode(&buf, "size", "1280", "720", "96"); err != nil {
		t.Fatal(err)
	}
	got := buf.String()
	want := "4.size,4.1280,3.720,2.96;"
	if got != want {
		t.Fatalf("want %q got %q", want, got)
	}
}

func TestReadInstructionRoundtrip(t *testing.T) {
	in := "4.size,4.1280,3.720,2.96;6.select,3.rdp;"
	br := bufio.NewReader(strings.NewReader(in))
	op, args, err := ReadInstruction(br)
	if err != nil {
		t.Fatal(err)
	}
	if op != "size" || len(args) != 3 || args[0] != "1280" || args[2] != "96" {
		t.Fatalf("bad parse: %s / %v", op, args)
	}
	op2, args2, err := ReadInstruction(br)
	if err != nil {
		t.Fatal(err)
	}
	if op2 != "select" || len(args2) != 1 || args2[0] != "rdp" {
		t.Fatalf("bad parse 2: %s / %v", op2, args2)
	}
}

func TestParamValueSocksWiring(t *testing.T) {
	p := ConnectParams{
		SOCKSHost: "127.0.0.1", SOCKSPort: 41234,
		RecordingPath: "/var/lib/sessions/2026-05-17",
		RecordingName: "abc.guac",
	}
	cases := map[string]string{
		"socks-proxy-host":         "127.0.0.1",
		"socks-proxy-port":         "41234",
		"recording-path":           "/var/lib/sessions/2026-05-17",
		"recording-name":           "abc.guac",
		"recording-include-output": "true",
		"recording-write-existing": "true",
	}
	for k, want := range cases {
		got := paramValue(k, p)
		if got != want {
			t.Errorf("%s: want %q got %q", k, want, got)
		}
	}
}
