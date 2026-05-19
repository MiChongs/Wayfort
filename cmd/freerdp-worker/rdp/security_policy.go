package rdp

const (
	freerdpCertDeny              uint32 = 0
	freerdpCertAcceptPermanently uint32 = 2
)

func certificateVerifyDecision(ignoreCert bool) uint32 {
	if ignoreCert {
		return freerdpCertAcceptPermanently
	}
	return freerdpCertDeny
}
