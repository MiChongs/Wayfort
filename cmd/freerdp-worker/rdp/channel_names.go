package rdp

const (
	rdpgfxShortChannelName = "rdpgfx"
	rdpgfxWireChannelName  = "Microsoft::Windows::RDS::Graphics"
)

func isRdpgfxChannelName(name string) bool {
	return name == rdpgfxShortChannelName || name == rdpgfxWireChannelName
}
