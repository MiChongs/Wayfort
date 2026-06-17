package wireguard

import (
	"context"
	"crypto/sha256"
	"encoding/base64"
	"encoding/hex"
	"fmt"
	"net/netip"
	"strings"
	"time"

	"github.com/michongs/wayfort/internal/model"
)

// config_file.go owns the on-disk /etc/wireguard/<name>.conf surface: parsing
// it into a structured view, rendering a structured view back to canonical
// text, reading it (with secrets masked), writing it atomically with a
// timestamped backup, diffing a pending change, and allocating the next free
// address in an interface's subnet.

// IfaceConfig is the structured view of a wgX.conf [Interface] section plus its
// peers. PrivateKey is only populated internally; it is masked before leaving
// the API (the frontend never needs it).
type IfaceConfig struct {
	Name       string       `json:"name"`
	PrivateKey string       `json:"private_key,omitempty"`
	PublicKey  string       `json:"public_key,omitempty"`
	Address    []string     `json:"address"`
	ListenPort int          `json:"listen_port,omitempty"`
	DNS        []string     `json:"dns,omitempty"`
	MTU        int          `json:"mtu,omitempty"`
	PreUp      []string     `json:"pre_up,omitempty"`
	PostUp     []string     `json:"post_up,omitempty"`
	PreDown    []string     `json:"pre_down,omitempty"`
	PostDown   []string     `json:"post_down,omitempty"`
	SaveConfig bool         `json:"save_config,omitempty"`
	Peers      []PeerConfig `json:"peers"`
	// Warning is a transient, non-fatal note returned by CreateIface (e.g. the
	// conf was written but wg-quick up failed). Never parsed from disk.
	Warning string `json:"warning,omitempty"`
}

// PeerConfig is one [Peer] section. Comment carries the "# Name = ..." alias
// line that precedes the section so the UI can show a friendly label.
type PeerConfig struct {
	PublicKey           string   `json:"public_key"`
	PresharedKey        string   `json:"preshared_key,omitempty"`
	AllowedIPs          []string `json:"allowed_ips"`
	Endpoint            string   `json:"endpoint,omitempty"`
	PersistentKeepalive int      `json:"persistent_keepalive,omitempty"`
	Comment             string   `json:"comment,omitempty"`
}

// ConfRaw is the literal conf text (secrets masked unless reveal) plus a sha256
// the caller can pass back to WriteConf as an optimistic lock.
type ConfRaw struct {
	Name      string    `json:"name"`
	Path      string    `json:"path"`
	Content   string    `json:"content"`
	Exists    bool      `json:"exists"`
	SHA256    string    `json:"sha256,omitempty"`
	SampledAt time.Time `json:"sampled_at"`
}

// ConfDiff is a before/after pair for the frontend diff viewer (Monaco computes
// the visual diff). Both sides are masked.
type ConfDiff struct {
	Name     string `json:"name"`
	Original string `json:"original"`
	Modified string `json:"modified"`
	Changed  bool   `json:"changed"`
}

const noConfSentinel = "__NO_CONF__"

func (m *Manager) confPath(name string) string { return m.cfg.ConfDir + "/" + name + ".conf" }

// ---- parsing ----

// parseConf parses a wgX.conf into IfaceConfig. WireGuard conf is a simplified
// INI: [Interface]/[Peer] sections, case-insensitive keys, some repeatable
// (PostUp/Address/AllowedIPs). A "# Name = x" comment before a [Peer] becomes
// that peer's Comment.
func parseConf(name, content string) (*IfaceConfig, error) {
	cfg := &IfaceConfig{Name: name}
	section := ""            // "interface" | "peer" | ""
	pendingComment := ""     // "# Name = ..." waiting for the next [Peer]
	var cur *PeerConfig      // current peer being filled
	sawInterface := false

	for _, raw := range strings.Split(content, "\n") {
		line := strings.TrimSpace(strings.TrimRight(raw, "\r"))
		if line == "" {
			continue
		}
		if strings.HasPrefix(line, "#") || strings.HasPrefix(line, ";") {
			// Capture a "# Name = alias" hint; ignore other comments.
			body := strings.TrimSpace(strings.TrimLeft(line, "#; "))
			if k, v, ok := splitKV(body); ok && strings.EqualFold(k, "Name") {
				pendingComment = v
			}
			continue
		}
		if strings.HasPrefix(line, "[") && strings.HasSuffix(line, "]") {
			switch strings.ToLower(strings.TrimSpace(line[1 : len(line)-1])) {
			case "interface":
				section = "interface"
				sawInterface = true
			case "peer":
				section = "peer"
				cfg.Peers = append(cfg.Peers, PeerConfig{Comment: pendingComment})
				cur = &cfg.Peers[len(cfg.Peers)-1]
				pendingComment = ""
			default:
				section = ""
			}
			continue
		}
		k, v, ok := splitKV(line)
		if !ok {
			continue
		}
		switch section {
		case "interface":
			applyInterfaceKey(cfg, k, v)
		case "peer":
			if cur != nil {
				applyPeerKey(cur, k, v)
			}
		}
	}
	if !sawInterface {
		return nil, ErrConfParse
	}
	return cfg, nil
}

func applyInterfaceKey(cfg *IfaceConfig, k, v string) {
	switch strings.ToLower(k) {
	case "privatekey":
		cfg.PrivateKey = v
	case "address":
		cfg.Address = append(cfg.Address, splitCSV(v)...)
	case "listenport":
		cfg.ListenPort = atoi(v)
	case "dns":
		cfg.DNS = append(cfg.DNS, splitCSV(v)...)
	case "mtu":
		cfg.MTU = atoi(v)
	case "preup":
		cfg.PreUp = append(cfg.PreUp, v)
	case "postup":
		cfg.PostUp = append(cfg.PostUp, v)
	case "predown":
		cfg.PreDown = append(cfg.PreDown, v)
	case "postdown":
		cfg.PostDown = append(cfg.PostDown, v)
	case "saveconfig":
		cfg.SaveConfig = strings.EqualFold(v, "true")
	}
}

func applyPeerKey(p *PeerConfig, k, v string) {
	switch strings.ToLower(k) {
	case "publickey":
		p.PublicKey = v
	case "presharedkey":
		p.PresharedKey = v
	case "allowedips":
		p.AllowedIPs = append(p.AllowedIPs, splitCSV(v)...)
	case "endpoint":
		p.Endpoint = v
	case "persistentkeepalive":
		p.PersistentKeepalive = atoi(v)
	}
}

// renderConf renders an IfaceConfig back to canonical, deterministic text so
// diffs stay stable.
func renderConf(cfg *IfaceConfig) string {
	var b strings.Builder
	b.WriteString("[Interface]\n")
	if cfg.PrivateKey != "" {
		fmt.Fprintf(&b, "PrivateKey = %s\n", cfg.PrivateKey)
	}
	if len(cfg.Address) > 0 {
		fmt.Fprintf(&b, "Address = %s\n", strings.Join(cfg.Address, ", "))
	}
	if cfg.ListenPort > 0 {
		fmt.Fprintf(&b, "ListenPort = %d\n", cfg.ListenPort)
	}
	if cfg.MTU > 0 {
		fmt.Fprintf(&b, "MTU = %d\n", cfg.MTU)
	}
	if len(cfg.DNS) > 0 {
		fmt.Fprintf(&b, "DNS = %s\n", strings.Join(cfg.DNS, ", "))
	}
	if cfg.SaveConfig {
		b.WriteString("SaveConfig = true\n")
	}
	for _, l := range cfg.PreUp {
		fmt.Fprintf(&b, "PreUp = %s\n", l)
	}
	for _, l := range cfg.PostUp {
		fmt.Fprintf(&b, "PostUp = %s\n", l)
	}
	for _, l := range cfg.PreDown {
		fmt.Fprintf(&b, "PreDown = %s\n", l)
	}
	for _, l := range cfg.PostDown {
		fmt.Fprintf(&b, "PostDown = %s\n", l)
	}
	for _, p := range cfg.Peers {
		b.WriteString("\n")
		if p.Comment != "" {
			fmt.Fprintf(&b, "# Name = %s\n", p.Comment)
		}
		b.WriteString("[Peer]\n")
		if p.PublicKey != "" {
			fmt.Fprintf(&b, "PublicKey = %s\n", p.PublicKey)
		}
		if p.PresharedKey != "" {
			fmt.Fprintf(&b, "PresharedKey = %s\n", p.PresharedKey)
		}
		if len(p.AllowedIPs) > 0 {
			fmt.Fprintf(&b, "AllowedIPs = %s\n", strings.Join(p.AllowedIPs, ", "))
		}
		if p.Endpoint != "" {
			fmt.Fprintf(&b, "Endpoint = %s\n", p.Endpoint)
		}
		if p.PersistentKeepalive > 0 {
			fmt.Fprintf(&b, "PersistentKeepalive = %d\n", p.PersistentKeepalive)
		}
	}
	return b.String()
}

// parseStatus splits the aggregated statusScript output and assembles a Status:
// live interfaces/peers from the dump, merged with conf metadata (Address/MTU/
// DNS + conf-only interfaces), autostart state, and the kernel-module result.
func parseStatus(raw string) *Status {
	st := &Status{Installed: true, SampledAt: time.Now().UTC()}
	if strings.TrimSpace(raw) == "__NO_WG__" {
		st.Installed = false
		st.Reason = "目标主机未安装 WireGuard（未找到 wg 命令）。"
		return st
	}
	sections := map[string][]string{}
	cur := ""
	for _, line := range strings.Split(raw, "\n") {
		line = strings.TrimRight(line, "\r")
		switch line {
		case "===DUMP===", "===CONF===", "===ENABLED===", "===MOD===":
			cur = line
			continue
		case "===END===":
			cur = ""
			continue
		}
		if cur != "" {
			sections[cur] = append(sections[cur], line)
		}
	}

	byName := map[string]*Iface{}
	order := []string{}
	get := func(name string) *Iface {
		if ifc := byName[name]; ifc != nil {
			return ifc
		}
		ni := &Iface{Name: name}
		byName[name] = ni
		order = append(order, name)
		return ni
	}

	// Live interfaces (kernel).
	for _, d := range parseDump(strings.Join(sections["===DUMP==="], "\n")) {
		ifc := get(d.Name)
		ifc.PublicKey = d.PublicKey
		ifc.ListenPort = d.ListenPort
		ifc.Peers = d.Peers
		ifc.Up = true
	}

	// Conf metadata + conf-only interfaces.
	for name, cfg := range parseConfSection(sections["===CONF==="]) {
		ifc := get(name)
		ifc.HasConf = true
		ifc.Addresses = cfg.Address
		ifc.MTU = cfg.MTU
		ifc.DNS = cfg.DNS
		if ifc.ListenPort == 0 {
			ifc.ListenPort = cfg.ListenPort
		}
	}

	// Autostart.
	for _, line := range sections["===ENABLED==="] {
		f := strings.Fields(line)
		if len(f) >= 2 {
			if ifc := byName[f[0]]; ifc != nil {
				ifc.Autostart = f[1] == "enabled"
			}
		}
	}

	// Kernel module.
	mod := strings.TrimSpace(strings.Join(sections["===MOD==="], "\n"))
	st.KernelMod = mod == "loaded" || mod == "available" || mod == "userspace"

	out := make([]Iface, 0, len(order))
	for _, n := range order {
		out = append(out, *byName[n])
	}
	st.Ifaces = out
	st.Available = len(out) > 0
	if !st.Available {
		st.Reason = "未发现 WireGuard 接口或配置；可创建新接口，或检查 SSH 用户是否有读取权限（需 root / sudo NOPASSWD）。"
	}
	return st
}

// parseConfSection turns the CONF block (a sequence of "@@FILE@@ <path>" …
// "@@ENDFILE@@" groups) into a map of interface name → parsed config.
func parseConfSection(lines []string) map[string]*IfaceConfig {
	out := map[string]*IfaceConfig{}
	name := ""
	var buf []string
	flush := func() {
		if name != "" {
			if cfg, err := parseConf(name, strings.Join(buf, "\n")); err == nil {
				out[name] = cfg
			}
		}
		name, buf = "", nil
	}
	for _, line := range lines {
		if strings.HasPrefix(line, "@@FILE@@ ") {
			flush()
			path := strings.TrimSpace(strings.TrimPrefix(line, "@@FILE@@ "))
			base := path
			if i := strings.LastIndexByte(base, '/'); i >= 0 {
				base = base[i+1:]
			}
			name = strings.TrimSuffix(base, ".conf")
			continue
		}
		if line == "@@ENDFILE@@" {
			flush()
			continue
		}
		if name != "" {
			buf = append(buf, line)
		}
	}
	flush()
	return out
}

// ---- read / write / diff ----

// ReadConf returns the raw conf text. Secrets are masked unless reveal is true
// (reveal is only honoured for callers holding wireguard:manage; the route for
// the read endpoint never reveals).
func (m *Manager) ReadConf(ctx context.Context, userID, nodeID uint64, name string, reveal bool) (*ConfRaw, error) {
	node, cred, err := m.gateAndLoad(ctx, userID, nodeID)
	if err != nil {
		return nil, err
	}
	if !validIface(name) {
		return nil, ErrBadIface
	}
	out, exists, err := m.readConfRaw(ctx, node, cred, name)
	if err != nil {
		return nil, err
	}
	if !exists {
		return &ConfRaw{Name: name, Path: m.confPath(name), Exists: false, SampledAt: time.Now().UTC()}, nil
	}
	sum := sha256.Sum256([]byte(out))
	content := out
	if !reveal {
		content = maskSecrets(out)
	}
	return &ConfRaw{
		Name: name, Path: m.confPath(name), Content: content, Exists: true,
		SHA256: hex.EncodeToString(sum[:]), SampledAt: time.Now().UTC(),
	}, nil
}

// readConfRaw reads <name>.conf unmasked over the pooled SSH connection. It does
// not gate (callers already hold node+cred) so it is reusable by the iface/peer
// mutators that need the real PrivateKey to re-render the file.
func (m *Manager) readConfRaw(ctx context.Context, node *model.Node, cred *model.Credential, name string) (string, bool, error) {
	q := shellQuote(m.confPath(name))
	cmd := fmt.Sprintf(`if [ ! -e %s ]; then echo %s; else (sudo -n cat %s 2>/dev/null || cat %s 2>/dev/null); fi`,
		q, noConfSentinel, q, q)
	out, err := m.runWG(ctx, node, cred, cmd, "read conf", m.cfg.SSHTimeout)
	if err != nil {
		return "", false, err
	}
	if strings.TrimSpace(out) == noConfSentinel {
		return "", false, nil
	}
	return out, true, nil
}

// WriteConf atomically writes content to <name>.conf: optional sha256 optimistic
// lock, a timestamped backup of the existing file, then a 600-mode temp file
// renamed into place. The content travels as a base64 literal (no shell
// interpolation of the multi-line/secret payload).
func (m *Manager) WriteConf(ctx context.Context, userID, nodeID uint64, claims AuditClaims, name, content, expectSHA string) error {
	node, cred, err := m.gateAndLoad(ctx, userID, nodeID)
	if err != nil {
		return err
	}
	if !validIface(name) {
		return ErrBadIface
	}
	out, err := m.writeConfRaw(ctx, node, cred, name, content, expectSHA)
	if err != nil {
		return err
	}
	if strings.Contains(out, "__SHA_MISMATCH__") {
		return ErrConfConflict
	}
	m.invalidate(nodeID)
	sum := sha256.Sum256([]byte(content))
	m.recordAudit(claims, nodeID, fmt.Sprintf("wireguard write conf %s sha=%s", name, hex.EncodeToString(sum[:])[:8]))
	return nil
}

// writeConfRaw performs the privileged write and returns combined output. It is
// reused by the iface/peer mutators (which audit with richer payloads), so it
// does not audit or invalidate itself.
func (m *Manager) writeConfRaw(ctx context.Context, node *model.Node, cred *model.Credential, name, content, expectSHA string) (string, error) {
	path := m.confPath(name)
	b64 := base64.StdEncoding.EncodeToString([]byte(content))
	ts := nowStamp()
	// Inner script is single-quoted at the sudo layer; every interpolated value
	// (path, dir, timestamp, sha, base64) is metacharacter-free, so the quoting
	// holds. base64 decode lands the real bytes without any interpolation.
	inner := fmt.Sprintf(`set -e
CONF="%s"
if [ -n "%s" ] && [ -e "$CONF" ]; then cur=$(sha256sum "$CONF" 2>/dev/null | cut -d' ' -f1); if [ "$cur" != "%s" ]; then echo __SHA_MISMATCH__; exit 3; fi; fi
if [ -e "$CONF" ]; then cp -a "$CONF" "$CONF.bak.%s"; fi
TMP=$(mktemp "%s/.wgtmp.XXXXXX")
printf %%s "%s" | base64 -d > "$TMP"
chmod 600 "$TMP"
mv -f "$TMP" "$CONF"`,
		path, expectSHA, expectSHA, ts, m.cfg.ConfDir, b64)
	cmd := fmt.Sprintf("sudo -n sh -c '%s' 2>&1 || sh -c '%s' 2>&1", inner, inner)
	return m.runWG(ctx, node, cred, cmd, "write conf", m.cfg.SSHTimeout)
}

// DiffConf returns the on-disk conf (masked) alongside the proposed new content
// (masked) for a pre-apply preview. It has no side effects.
func (m *Manager) DiffConf(ctx context.Context, userID, nodeID uint64, name, newContent string) (*ConfDiff, error) {
	cur, err := m.ReadConf(ctx, userID, nodeID, name, false)
	if err != nil {
		return nil, err
	}
	modified := maskSecrets(newContent)
	return &ConfDiff{
		Name:     name,
		Original: cur.Content,
		Modified: modified,
		Changed:  cur.Content != modified,
	}, nil
}

// ---- address allocation ----

// nextFreeIP returns the next unused host address in the interface's subnet,
// given the interface addresses (to derive the subnet + reserve the gateway IP)
// and the AllowedIPs already handed out. Prefers an IPv4 subnet, falling back to
// the first IPv6 one. The result is a bare host address; callers format it /32
// (v4) or /128 (v6).
func nextFreeIP(ifaceAddrs, taken []string) (netip.Addr, error) {
	var prefix netip.Prefix
	found := false
	for _, a := range ifaceAddrs {
		p, err := netip.ParsePrefix(strings.TrimSpace(a))
		if err != nil {
			continue
		}
		if p.Addr().Is4() {
			prefix = p
			found = true
			break
		}
		if !found {
			prefix = p
			found = true // remember v6, keep scanning for a v4
		}
	}
	if !found {
		return netip.Addr{}, ErrBadCIDR
	}

	used := map[netip.Addr]struct{}{}
	// Reserve every interface address (gateway IPs).
	for _, a := range ifaceAddrs {
		if p, err := netip.ParsePrefix(strings.TrimSpace(a)); err == nil {
			used[p.Addr()] = struct{}{}
		}
	}
	for _, t := range taken {
		if p, err := netip.ParsePrefix(strings.TrimSpace(t)); err == nil {
			used[p.Addr()] = struct{}{}
		} else if ad, err := netip.ParseAddr(strings.TrimSpace(t)); err == nil {
			used[ad] = struct{}{}
		}
	}

	network := prefix.Masked()
	addr := network.Addr().Next()
	for i := 0; i < 65536 && prefix.Contains(addr); i++ {
		// IPv4: skip the broadcast address (the last address in the prefix).
		if addr.Is4() && !prefix.Contains(addr.Next()) {
			break
		}
		if _, ok := used[addr]; !ok {
			return addr, nil
		}
		addr = addr.Next()
	}
	return netip.Addr{}, ErrSubnetFull
}

// ---- helpers ----

// maskSecrets replaces PrivateKey / PresharedKey values so conf text can be
// shown in the UI without leaking key material.
func maskSecrets(content string) string {
	out := make([]string, 0, 32)
	for _, raw := range strings.Split(content, "\n") {
		line := raw
		trimmed := strings.TrimSpace(line)
		lower := strings.ToLower(trimmed)
		if strings.HasPrefix(lower, "privatekey") || strings.HasPrefix(lower, "presharedkey") {
			if i := strings.IndexByte(line, '='); i >= 0 {
				line = line[:i+1] + " (hidden)"
			}
		}
		out = append(out, line)
	}
	return strings.Join(out, "\n")
}

// nowStamp returns a compact UTC timestamp suitable for backup filenames.
func nowStamp() string { return time.Now().UTC().Format("20060102T150405Z") }

func splitKV(s string) (string, string, bool) {
	i := strings.IndexByte(s, '=')
	if i < 0 {
		return "", "", false
	}
	return strings.TrimSpace(s[:i]), strings.TrimSpace(s[i+1:]), true
}

func splitCSV(s string) []string {
	parts := strings.Split(s, ",")
	out := make([]string, 0, len(parts))
	for _, p := range parts {
		if t := strings.TrimSpace(p); t != "" {
			out = append(out, t)
		}
	}
	return out
}
