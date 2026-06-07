package nettools

import (
	"encoding/json"
	"fmt"
	"regexp"
	"strings"
)

const snapshotScript = `LC_ALL=C
echo '===ADDR==='
ip -j addr show 2>/dev/null
echo '===ROUTE==='
ip -j route show 2>/dev/null
echo '===SS==='
ss -tunaH 2>/dev/null | head -300
echo '===END==='
`

var (
	hostRe  = regexp.MustCompile(`^[A-Za-z0-9._:-]{1,253}$`)
	urlRe   = regexp.MustCompile(`^https?://[A-Za-z0-9._:/?=&%~+#@-]{1,400}$`)
	ifaceRe = regexp.MustCompile(`^[A-Za-z0-9._@:-]{1,32}$`)
)

func validIface(s string) bool { return s != "" && ifaceRe.MatchString(s) }

func shellQuote(s string) string {
	return "'" + strings.ReplaceAll(s, "'", `'\''`) + "'"
}

// diagCommand builds a validated diagnostic command. curl takes a URL; the rest
// take a host/IP. The target is charset-validated and single-quoted.
func diagCommand(tool DiagTool, target string) (string, error) {
	switch tool {
	case ToolCurl:
		if !urlRe.MatchString(target) {
			return "", ErrBadTarget
		}
		return fmt.Sprintf("curl -sS -I --max-time 10 %s 2>&1", shellQuote(target)), nil
	case ToolPing:
		if !hostRe.MatchString(target) {
			return "", ErrBadTarget
		}
		return fmt.Sprintf("ping -c 4 -W 2 %s 2>&1", shellQuote(target)), nil
	case ToolTraceroute:
		if !hostRe.MatchString(target) {
			return "", ErrBadTarget
		}
		return fmt.Sprintf("traceroute -w 2 -q 1 -m 20 %s 2>&1 || tracepath %s 2>&1", shellQuote(target), shellQuote(target)), nil
	case ToolDig:
		if !hostRe.MatchString(target) {
			return "", ErrBadTarget
		}
		return fmt.Sprintf("dig +short %s 2>&1; echo '---'; dig %s 2>&1 | head -30 || host %s 2>&1", shellQuote(target), shellQuote(target), shellQuote(target)), nil
	case ToolMTR:
		if !hostRe.MatchString(target) {
			return "", ErrBadTarget
		}
		return fmt.Sprintf("mtr --report --report-cycles 4 %s 2>&1", shellQuote(target)), nil
	default:
		return "", ErrBadTool
	}
}

// ---- snapshot parsers ----

type rawAddr struct {
	IfName    string `json:"ifname"`
	Address   string `json:"address"`
	Operstate string `json:"operstate"`
	MTU       int    `json:"mtu"`
	AddrInfo  []struct {
		Family string `json:"family"`
		Local  string `json:"local"`
	} `json:"addr_info"`
}

func parseAddr(s string) []Iface {
	var list []rawAddr
	if err := json.Unmarshal([]byte(strings.TrimSpace(s)), &list); err != nil {
		return nil
	}
	out := make([]Iface, 0, len(list))
	for _, a := range list {
		ifc := Iface{Name: a.IfName, MAC: a.Address, State: strings.ToUpper(a.Operstate), MTU: a.MTU}
		if ifc.State == "" {
			ifc.State = "UNKNOWN"
		}
		for _, ai := range a.AddrInfo {
			if ai.Family == "inet" {
				ifc.IPv4 = append(ifc.IPv4, ai.Local)
			} else if ai.Family == "inet6" {
				ifc.IPv6 = append(ifc.IPv6, ai.Local)
			}
		}
		out = append(out, ifc)
	}
	return out
}

type rawRoute struct {
	Dst      string `json:"dst"`
	Gateway  string `json:"gateway"`
	Dev      string `json:"dev"`
	Protocol string `json:"protocol"`
	PrefSrc  string `json:"prefsrc"`
}

func parseRoute(s string) []Route {
	var list []rawRoute
	if err := json.Unmarshal([]byte(strings.TrimSpace(s)), &list); err != nil {
		return nil
	}
	out := make([]Route, 0, len(list))
	for _, r := range list {
		out = append(out, Route{Dst: r.Dst, Via: r.Gateway, Dev: r.Dev, Proto: r.Protocol, Src: r.PrefSrc})
	}
	return out
}

// parseSS reads `ss -tunaH`: Netid State Recv-Q Send-Q Local Peer [Process].
func parseSS(s string) []Conn {
	out := []Conn{}
	for _, line := range splitNonEmptyLines(s) {
		f := strings.Fields(line)
		if len(f) < 6 {
			continue
		}
		c := Conn{Proto: f[0], State: f[1], Local: f[4], Peer: f[5]}
		for _, tok := range f {
			if strings.HasPrefix(tok, "users:") {
				c.Process = parseUsers(tok)
			}
		}
		out = append(out, c)
	}
	return out
}

func parseUsers(s string) string {
	i := strings.Index(s, `("`)
	if i < 0 {
		return ""
	}
	rest := s[i+2:]
	q := strings.IndexByte(rest, '"')
	if q < 0 {
		return ""
	}
	return rest[:q]
}

func splitNonEmptyLines(s string) []string {
	out := []string{}
	for _, line := range strings.Split(s, "\n") {
		t := strings.TrimRight(line, "\r")
		if strings.TrimSpace(t) == "" {
			continue
		}
		out = append(out, t)
	}
	return out
}
