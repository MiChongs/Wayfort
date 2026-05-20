//go:build freerdp

package rdp

import (
	"bytes"
	"testing"
)

func TestStripAvc420Wrapper(t *testing.T) {
	t.Parallel()

	payload := []byte{0x00, 0x00, 0x00, 0x01, 0x65, 0xaa}
	buf := append([]byte{
		0x02, 0x00, 0x00, 0x00, // two region rects
		0x00, 0x00, 0x10, 0x00, 0x00, 0x00, 0x10, 0x00,
		0x10, 0x00, 0x20, 0x00, 0x10, 0x00, 0x20, 0x00,
		0x1f, 0x64, 0x1f, 0x64,
	}, payload...)

	got, ok := stripAvc420Wrapper(buf)
	if !ok {
		t.Fatal("stripAvc420Wrapper returned ok=false")
	}
	if !bytes.Equal(got, payload) {
		t.Fatalf("stripAvc420Wrapper payload = %x, want %x", got, payload)
	}

	for name, input := range map[string][]byte{
		"short":       {0x01, 0x00, 0x00},
		"implausible": {0x01, 0x10, 0x00, 0x00},
		"truncated":   {0x01, 0x00, 0x00, 0x00, 0x00},
	} {
		input := input
		t.Run(name, func(t *testing.T) {
			t.Parallel()
			if got, ok := stripAvc420Wrapper(input); ok || got != nil {
				t.Fatalf("stripAvc420Wrapper(%x) = (%x, %v), want (nil, false)", input, got, ok)
			}
		})
	}
}

func TestNormalizeH264AnnexB(t *testing.T) {
	t.Parallel()

	annexB := []byte{0x00, 0x00, 0x01, 0x65, 0x88}
	got, ok := normalizeH264AnnexB(annexB)
	if !ok {
		t.Fatal("normalizeH264AnnexB rejected Annex-B stream")
	}
	if !bytes.Equal(got, annexB) {
		t.Fatalf("normalizeH264AnnexB Annex-B = %x, want %x", got, annexB)
	}

	avcc := []byte{
		0x00, 0x00, 0x00, 0x02, 0x65, 0xaa,
		0x00, 0x00, 0x00, 0x01, 0x41,
	}
	want := []byte{
		0x00, 0x00, 0x00, 0x01, 0x65, 0xaa,
		0x00, 0x00, 0x00, 0x01, 0x41,
	}
	got, ok = normalizeH264AnnexB(avcc)
	if !ok {
		t.Fatal("normalizeH264AnnexB rejected AVCC stream")
	}
	if !bytes.Equal(got, want) {
		t.Fatalf("normalizeH264AnnexB AVCC = %x, want %x", got, want)
	}

	for name, input := range map[string][]byte{
		"empty":       nil,
		"short_avcc":  {0x00, 0x00, 0x00, 0x01},
		"zero_length": {0x00, 0x00, 0x00, 0x00, 0x65},
		"truncated":   {0x00, 0x00, 0x00, 0x02, 0x65},
	} {
		input := input
		t.Run(name, func(t *testing.T) {
			t.Parallel()
			if got, ok := normalizeH264AnnexB(input); ok || got != nil {
				t.Fatalf("normalizeH264AnnexB(%x) = (%x, %v), want (nil, false)", input, got, ok)
			}
		})
	}
}

func TestNalStreamHasKeyframe(t *testing.T) {
	t.Parallel()

	tests := []struct {
		name string
		nal  []byte
		want bool
	}{
		{
			name: "sps_pps_only",
			nal:  []byte{0x00, 0x00, 0x00, 0x01, 0x67, 0x11, 0x00, 0x00, 0x01, 0x68, 0x22},
			want: false,
		},
		{
			name: "idr_four_byte_start_code",
			nal:  []byte{0x00, 0x00, 0x00, 0x01, 0x65, 0x88},
			want: true,
		},
		{
			name: "idr_three_byte_start_code",
			nal:  []byte{0x00, 0x00, 0x01, 0x65, 0x88},
			want: true,
		},
		{
			name: "non_idr_slice",
			nal:  []byte{0x00, 0x00, 0x01, 0x41, 0x88},
			want: false,
		},
	}

	for _, tt := range tests {
		tt := tt
		t.Run(tt.name, func(t *testing.T) {
			t.Parallel()
			if got := nalStreamHasKeyframe(tt.nal); got != tt.want {
				t.Fatalf("nalStreamHasKeyframe(%x) = %v, want %v", tt.nal, got, tt.want)
			}
		})
	}
}
