package wireguard

import (
	"context"
	"fmt"
	"strings"

	"github.com/michongs/jumpserver-anonymous/internal/model"
)

// iface.go owns the interface lifecycle: key generation, create / update /
// delete, and systemd autostart. Config writes go through config_file.go's
// atomic+backed-up writeConfRaw; destructive ops require an explicit confirm.

// KeyPair is a freshly generated WireGuard private/public key pair.
type KeyPair struct {
	PrivateKey string `json:"private_key"`
	PublicKey  string `json:"public_key"`
}

// ApplyMode controls how a config change is made live.
type ApplyMode string

const (
	ApplyNone   ApplyMode = "none"   // persist only
	ApplySync   ApplyMode = "sync"   // wg syncconf — no tunnel drop
	ApplyReload ApplyMode = "reload" // wg-quick down && up — brief drop, picks up Address/MTU
)

// CreateIfaceReq describes a new interface.
type CreateIfaceReq struct {
	Name       string   `json:"name"`
	Address    []string `json:"address"`
	ListenPort int      `json:"listen_port"`
	DNS        []string `json:"dns"`
	MTU        int      `json:"mtu"`
	PrivateKey string   `json:"private_key"` // optional; generated if empty
	SaveConfig bool     `json:"save_config"`
	EnableNAT  bool     `json:"enable_nat"`
	NATEgress  string   `json:"nat_egress"`
	Autostart  bool     `json:"autostart"`
	BringUp    bool     `json:"bring_up"`
}

// UpdateIfaceReq carries only the fields to change (nil = leave as-is).
type UpdateIfaceReq struct {
	Address    *[]string `json:"address"`
	ListenPort *int      `json:"listen_port"`
	DNS        *[]string `json:"dns"`
	MTU        *int      `json:"mtu"`
	PostUp     *[]string `json:"post_up"`
	PostDown   *[]string `json:"post_down"`
}

// ---- key generation ----

// GenKeyPair generates a key pair on the node (private key never leaves the host
// except in this one response, which is no-store; callers needing a client key
// use it immediately). Gated by wireguard:manage.
func (m *Manager) GenKeyPair(ctx context.Context, userID, nodeID uint64) (*KeyPair, error) {
	node, cred, err := m.gateAndLoad(ctx, userID, nodeID)
	if err != nil {
		return nil, err
	}
	return m.genKeyPair(ctx, node, cred)
}

func (m *Manager) genKeyPair(ctx context.Context, node *model.Node, cred *model.Credential) (*KeyPair, error) {
	const cmd = `priv=$(wg genkey); pub=$(printf %s "$priv" | wg pubkey); printf '%s\n%s\n' "$priv" "$pub"`
	out, err := m.runWG(ctx, node, cred, cmd, "genkey", m.cfg.SSHTimeout)
	if err != nil {
		return nil, err
	}
	f := strings.Fields(strings.TrimSpace(out))
	if len(f) < 2 || !validWGKey(f[0]) || !validWGKey(f[1]) {
		return nil, fmt.Errorf("genkey: unexpected output")
	}
	return &KeyPair{PrivateKey: f[0], PublicKey: f[1]}, nil
}

// GenPSK generates a preshared key on the node. Gated by wireguard:manage.
func (m *Manager) GenPSK(ctx context.Context, userID, nodeID uint64) (string, error) {
	node, cred, err := m.gateAndLoad(ctx, userID, nodeID)
	if err != nil {
		return "", err
	}
	return m.genPSK(ctx, node, cred)
}

func (m *Manager) genPSK(ctx context.Context, node *model.Node, cred *model.Credential) (string, error) {
	out, err := m.runWG(ctx, node, cred, "wg genpsk", "genpsk", m.cfg.SSHTimeout)
	if err != nil {
		return "", err
	}
	psk := strings.TrimSpace(out)
	if !validWGKey(psk) {
		return "", fmt.Errorf("genpsk: unexpected output")
	}
	return psk, nil
}

func (m *Manager) pubFromPriv(ctx context.Context, node *model.Node, cred *model.Credential, priv string) (string, error) {
	if !validWGKey(priv) {
		return "", ErrBadKey
	}
	out, err := m.runWG(ctx, node, cred, fmt.Sprintf(`printf %%s %s | wg pubkey`, shellQuote(priv)), "pubkey", m.cfg.SSHTimeout)
	if err != nil {
		return "", err
	}
	pub := strings.TrimSpace(out)
	if !validWGKey(pub) {
		return "", fmt.Errorf("pubkey: unexpected output")
	}
	return pub, nil
}

// ---- interface CRUD ----

// GetIfaceConfig returns the structured (masked) conf for one interface. Read.
func (m *Manager) GetIfaceConfig(ctx context.Context, userID, nodeID uint64, name string) (*IfaceConfig, error) {
	node, cred, err := m.gateAndLoad(ctx, userID, nodeID)
	if err != nil {
		return nil, err
	}
	if !validIface(name) {
		return nil, ErrBadIface
	}
	content, exists, err := m.readConfRaw(ctx, node, cred, name)
	if err != nil {
		return nil, err
	}
	if !exists {
		return nil, ErrConfNotFound
	}
	cfg, err := parseConf(name, content)
	if err != nil {
		return nil, err
	}
	maskConfig(cfg)
	return cfg, nil
}

// CreateIface validates the request, generates keys if needed, writes a 600-mode
// conf (with NAT PostUp/PostDown when requested), then optionally enables
// autostart / forwarding / brings the interface up. Gated by wireguard:manage.
func (m *Manager) CreateIface(ctx context.Context, userID, nodeID uint64, claims AuditClaims, req CreateIfaceReq) (*IfaceConfig, error) {
	node, cred, err := m.gateAndLoad(ctx, userID, nodeID)
	if err != nil {
		return nil, err
	}
	if !validIface(req.Name) {
		return nil, ErrBadIface
	}
	if err := validateIfaceFields(req.Address, req.ListenPort, req.MTU, req.DNS); err != nil {
		return nil, err
	}
	if req.PrivateKey != "" && !validWGKey(req.PrivateKey) {
		return nil, ErrBadKey
	}
	if req.EnableNAT && !validEgressIface(req.NATEgress) {
		return nil, ErrBadEgress
	}

	// Refuse to clobber an existing conf. /etc/wireguard is 0700 root, so the
	// existence test must try sudo first (a plain test can't even stat inside it
	// as a non-root user, which would be a false "does not exist").
	q := shellQuote(m.confPath(req.Name))
	chk, err := m.runWG(ctx, node, cred,
		fmt.Sprintf(`(sudo -n test -e %s || test -e %s) && echo __EXISTS__ || echo __OK__`, q, q),
		"check conf", m.cfg.SSHTimeout)
	if err != nil {
		return nil, err
	}
	if strings.Contains(chk, "__EXISTS__") {
		return nil, ErrConfExists
	}

	priv, pub := req.PrivateKey, ""
	if priv == "" {
		kp, err := m.genKeyPair(ctx, node, cred)
		if err != nil {
			return nil, err
		}
		priv, pub = kp.PrivateKey, kp.PublicKey
	} else {
		if pub, err = m.pubFromPriv(ctx, node, cred, priv); err != nil {
			return nil, err
		}
	}

	port := req.ListenPort
	if port == 0 {
		port = m.cfg.DefaultListenPort
	}
	// NOTE: a server [Interface] must NOT carry DNS. wg-quick interprets DNS by
	// shelling out to resolvconf / resolvectl, which is frequently absent on
	// servers and makes `wg-quick up` fail (taking the whole create down with
	// it). DNS is a client-side concern and is emitted into the generated client
	// .conf instead (see NewClient). req.DNS is intentionally ignored here.
	cfg := &IfaceConfig{
		Name: req.Name, PrivateKey: priv, PublicKey: pub,
		Address: req.Address, ListenPort: port, MTU: req.MTU, SaveConfig: req.SaveConfig,
	}
	if req.EnableNAT {
		cfg.PostUp, cfg.PostDown = natRules(req.NATEgress)
	}
	if _, err := m.writeConfRaw(ctx, node, cred, req.Name, renderConf(cfg), ""); err != nil {
		return nil, err
	}

	if req.EnableNAT {
		// MASQUERADE in PostUp needs forwarding enabled to actually route.
		_ = m.enableForwardingRaw(ctx, node, cred, true)
	}
	if req.Autostart {
		_ = m.setAutostartRaw(ctx, node, cred, req.Name, true)
	}
	// Bringing the interface up is best-effort: the conf is already persisted, so
	// a failure here (missing kernel module, iptables quirk, address clash) must
	// not fail the whole create — otherwise the user sees an error yet the
	// interface exists. Surface it as a non-fatal warning instead.
	if req.BringUp {
		if out, upErr := m.runWG(ctx, node, cred, wgQuickCmd("up", req.Name), "wg-quick up", m.cfg.SSHTimeout); upErr != nil {
			cfg.Warning = "接口已创建，但自动启动失败（可在接口卡片手动启动并查看原因）：" + firstLine(out, upErr)
		}
	}

	m.invalidate(nodeID)
	m.recordAudit(claims, nodeID, fmt.Sprintf("wireguard create iface %s addr=%s port=%d nat=%v autostart=%v",
		req.Name, strings.Join(req.Address, ","), port, req.EnableNAT, req.Autostart))
	maskConfig(cfg)
	return cfg, nil
}

// UpdateIface applies the provided fields to the existing conf (preserving the
// private key + peers) and writes it back with a backup. Applying the change to
// the running interface is a separate streamed action (ApplyConfig). Returns the
// updated masked config. Gated by wireguard:manage.
func (m *Manager) UpdateIface(ctx context.Context, userID, nodeID uint64, claims AuditClaims, name string, req UpdateIfaceReq) (*IfaceConfig, error) {
	node, cred, err := m.gateAndLoad(ctx, userID, nodeID)
	if err != nil {
		return nil, err
	}
	if !validIface(name) {
		return nil, ErrBadIface
	}
	content, exists, err := m.readConfRaw(ctx, node, cred, name)
	if err != nil {
		return nil, err
	}
	if !exists {
		return nil, ErrConfNotFound
	}
	cfg, err := parseConf(name, content)
	if err != nil {
		return nil, err
	}

	changed := []string{}
	if req.Address != nil {
		if !validAllowedIPs(*req.Address) {
			return nil, ErrBadCIDR
		}
		cfg.Address = *req.Address
		changed = append(changed, "address")
	}
	if req.ListenPort != nil {
		if *req.ListenPort != 0 && !validPort(*req.ListenPort) {
			return nil, ErrBadPort
		}
		cfg.ListenPort = *req.ListenPort
		changed = append(changed, "listen_port")
	}
	if req.DNS != nil {
		if !validDNSList(*req.DNS) {
			return nil, ErrBadCIDR
		}
		cfg.DNS = *req.DNS
		changed = append(changed, "dns")
	}
	if req.MTU != nil {
		if !validMTU(*req.MTU) {
			return nil, ErrBadMTU
		}
		cfg.MTU = *req.MTU
		changed = append(changed, "mtu")
	}
	if req.PostUp != nil {
		cfg.PostUp = *req.PostUp
		changed = append(changed, "post_up")
	}
	if req.PostDown != nil {
		cfg.PostDown = *req.PostDown
		changed = append(changed, "post_down")
	}

	if _, err := m.writeConfRaw(ctx, node, cred, name, renderConf(cfg), ""); err != nil {
		return nil, err
	}
	m.invalidate(nodeID)
	m.recordAudit(claims, nodeID, fmt.Sprintf("wireguard update iface %s fields=[%s]", name, strings.Join(changed, ",")))
	maskConfig(cfg)
	return cfg, nil
}

// DeleteOpts gates the destructive interface delete.
type DeleteOpts struct {
	Confirm bool `json:"confirm"`
}

// DeleteIface brings the interface down, disables autostart, backs up the conf
// (so it can be restored), then removes it. Requires confirm=true. Gated by
// wireguard:manage.
func (m *Manager) DeleteIface(ctx context.Context, userID, nodeID uint64, claims AuditClaims, name string, opts DeleteOpts) error {
	node, cred, err := m.gateAndLoad(ctx, userID, nodeID)
	if err != nil {
		return err
	}
	if !validIface(name) {
		return ErrBadIface
	}
	if !opts.Confirm {
		return ErrConfirmRequired
	}
	unit := shellQuote("wg-quick@" + name)
	q := shellQuote(name)
	conf := shellQuote(m.confPath(name))
	ts := nowStamp()
	inner := fmt.Sprintf(`systemctl disable %s 2>/dev/null || true
wg-quick down %s 2>/dev/null || true
if [ -e %s ]; then cp -a %s %s.deleted.%s; fi
rm -f %s`, unit, q, conf, conf, conf, ts, conf)
	cmd := fmt.Sprintf("sudo -n sh -c '%s' 2>&1 || sh -c '%s' 2>&1", inner, inner)
	if _, err := m.runWG(ctx, node, cred, cmd, "delete iface", m.cfg.SSHTimeout); err != nil {
		return err
	}
	m.invalidate(nodeID)
	m.recordAudit(claims, nodeID, fmt.Sprintf("wireguard delete iface %s backup=%s.deleted.%s", name, m.confPath(name), ts))
	return nil
}

// SetAutostart enables/disables the wg-quick@<name> unit. Gated by
// wireguard:manage.
func (m *Manager) SetAutostart(ctx context.Context, userID, nodeID uint64, claims AuditClaims, name string, enable bool) error {
	node, cred, err := m.gateAndLoad(ctx, userID, nodeID)
	if err != nil {
		return err
	}
	if !validIface(name) {
		return ErrBadIface
	}
	if err := m.setAutostartRaw(ctx, node, cred, name, enable); err != nil {
		return err
	}
	m.invalidate(nodeID)
	m.recordAudit(claims, nodeID, fmt.Sprintf("wireguard autostart %s %s", enableWord(enable), name))
	return nil
}

func (m *Manager) setAutostartRaw(ctx context.Context, node *model.Node, cred *model.Credential, name string, enable bool) error {
	verb := "enable"
	if !enable {
		verb = "disable"
	}
	unit := shellQuote("wg-quick@" + name)
	cmd := fmt.Sprintf("sudo -n systemctl %s %s 2>&1 || systemctl %s %s 2>&1", verb, unit, verb, unit)
	_, err := m.runWG(ctx, node, cred, cmd, "systemctl "+verb, m.cfg.SSHTimeout)
	return err
}

// ---- helpers ----

// firstLine returns the first non-empty line of out (trimmed) for a concise
// warning, falling back to the error's message when out is empty.
func firstLine(out string, err error) string {
	for _, l := range strings.Split(out, "\n") {
		if t := strings.TrimSpace(l); t != "" {
			return truncate(t, 200)
		}
	}
	if err != nil {
		return truncate(err.Error(), 200)
	}
	return ""
}

// wgQuickCmd builds the sudo-preferring wg-quick up/down command for name.
func wgQuickCmd(verb, name string) string {
	q := shellQuote(name)
	return fmt.Sprintf("sudo -n wg-quick %s %s 2>&1 || wg-quick %s %s 2>&1", verb, q, verb, q)
}

func validateIfaceFields(address []string, port, mtu int, dns []string) error {
	if !validAllowedIPs(address) { // reuse: ≥1 valid CIDR
		return ErrBadCIDR
	}
	if port != 0 && !validPort(port) {
		return ErrBadPort
	}
	if !validMTU(mtu) {
		return ErrBadMTU
	}
	if !validDNSList(dns) {
		return ErrBadCIDR
	}
	return nil
}

// validDNSList allows an empty list, or entries that are bare IPs or hostnames.
func validDNSList(dns []string) bool {
	for _, d := range dns {
		d = strings.TrimSpace(d)
		if d == "" || (!validHostIP(d) && !validHostname(d)) {
			return false
		}
	}
	return true
}

// maskConfig hides key material before an IfaceConfig leaves the API.
func maskConfig(cfg *IfaceConfig) {
	if cfg.PrivateKey != "" {
		cfg.PrivateKey = "(hidden)"
	}
	for i := range cfg.Peers {
		if cfg.Peers[i].PresharedKey != "" {
			cfg.Peers[i].PresharedKey = "(hidden)"
		}
	}
}
