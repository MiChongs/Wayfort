package rdp

import "testing"

func TestIsRdpgfxChannelName(t *testing.T) {
	t.Parallel()

	tests := []struct {
		name string
		want bool
	}{
		{name: rdpgfxShortChannelName, want: true},
		{name: rdpgfxWireChannelName, want: true},
		{name: "cliprdr", want: false},
		{name: "Microsoft::Windows::RDS::Audio", want: false},
	}

	for _, tt := range tests {
		tt := tt
		t.Run(tt.name, func(t *testing.T) {
			t.Parallel()
			if got := isRdpgfxChannelName(tt.name); got != tt.want {
				t.Fatalf("isRdpgfxChannelName(%q) = %v, want %v", tt.name, got, tt.want)
			}
		})
	}
}
