//go:build freerdp

package rdp

import "strings"

// keyboardLayoutFromString maps a small set of operator-facing keyboard
// layout strings to the Windows LCID that goes into the GCC core data
// block. Win11 / Server 2022 silently drop MCS Connect Initial when the
// layout reaches the wire as 0, so unknown inputs fall back to en-US
// rather than passing through unset.
func keyboardLayoutFromString(s string) uint32 {
	switch strings.ToLower(strings.TrimSpace(s)) {
	case "", "en-us", "us", "en":
		return 0x0409
	case "zh-cn", "zh", "cn":
		return 0x0804
	case "zh-tw", "tw":
		return 0x0404
	case "ja-jp", "ja", "jp":
		return 0x0411
	case "ko-kr", "ko", "kr":
		return 0x0412
	case "de-de", "de":
		return 0x0407
	case "fr-fr", "fr":
		return 0x040C
	case "es-es", "es":
		return 0x040A
	case "pt-br":
		return 0x0416
	case "pt-pt", "pt":
		return 0x0816
	case "ru-ru", "ru":
		return 0x0419
	case "it-it", "it":
		return 0x0410
	case "en-gb", "gb", "uk":
		return 0x0809
	default:
		return 0x0409
	}
}
