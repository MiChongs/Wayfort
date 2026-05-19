package rdp

import "testing"

func TestCertificateVerifyDecision(t *testing.T) {
	tests := []struct {
		name       string
		ignoreCert bool
		want       uint32
	}{
		{name: "ignore cert accepts", ignoreCert: true, want: freerdpCertAcceptPermanently},
		{name: "verify cert denies unknown certificate", ignoreCert: false, want: freerdpCertDeny},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			if got := certificateVerifyDecision(tt.ignoreCert); got != tt.want {
				t.Fatalf("certificateVerifyDecision(%v) = %d, want %d", tt.ignoreCert, got, tt.want)
			}
		})
	}
}
