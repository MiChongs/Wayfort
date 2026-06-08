package wireguard

import (
	"context"
	"encoding/base64"
	"fmt"
	"strings"

	"github.com/michongs/jumpserver-anonymous/internal/model"
	"github.com/michongs/jumpserver-anonymous/internal/sshrun"
)

// peers.go owns peer CRUD with a double-write strategy: the change is applied to
// the running interface immediately via `wg set` (no tunnel drop) AND persisted
// to the conf file (so it survives a restart). ApplyConfig makes a broader conf
// edit live, either hot (wg syncconf) or with a brief reload.

// PeerReq describes a peer to add or update.
type PeerReq struct {
	PublicKey           string   `json:"public_key"`
	AllowedIPs          []string `json:"allowed_ips"`
	Endpoint            string   `json:"endpoint"`
	PersistentKeepalive int      `json:"persistent_keepalive"`
	PresharedKey        string   `json:"preshared_key"`
	Comment             string   `json:"comment"`
}

func (m *Manager) validatePeerReq(p PeerReq) error {
	if !validWGKey(p.PublicKey) {
		return ErrBadKey
	}
	if !validAllowedIPs(p.AllowedIPs) {
		return ErrBadAllowedIPs
	}
	if p.Endpoint != "" && !validEndpoint(p.Endpoint) {
		return ErrBadEndpoint
	}
	if !validKeepalive(p.PersistentKeepalive) {
		return ErrBadKeepalive
	}
	if p.PresharedKey != "" && !validWGKey(p.PresharedKey) {
		return ErrBadKey
	}
	return nil
}

// AddPeer adds a peer to <name>: persisted to conf + applied live. Gated by
// wireguard:manage.
func (m *Manager) AddPeer(ctx context.Context, userID, nodeID uint64, claims AuditClaims, name string, p PeerReq) error {
	node, cred, err := m.gateAndLoad(ctx, userID, nodeID)
	if err != nil {
		return err
	}
	if !validIface(name) {
		return ErrBadIface
	}
	if err := m.validatePeerReq(p); err != nil {
		return err
	}
	cfg, err := m.loadConf(ctx, node, cred, name)
	if err != nil {
		return err
	}
	if findPeer(cfg, p.PublicKey) >= 0 {
		return ErrPeerExists
	}
	cfg.Peers = append(cfg.Peers, peerConfigFromReq(p))
	if err := m.persistAndSync(ctx, node, cred, name, cfg, p, false); err != nil {
		return err
	}
	m.invalidate(nodeID)
	m.recordAudit(claims, nodeID, fmt.Sprintf("wireguard add peer %s iface=%s allowed=%s", keyFP(p.PublicKey), name, strings.Join(p.AllowedIPs, ",")))
	return nil
}

// UpdatePeer updates an existing peer in <name>. Gated by wireguard:manage.
func (m *Manager) UpdatePeer(ctx context.Context, userID, nodeID uint64, claims AuditClaims, name string, p PeerReq) error {
	node, cred, err := m.gateAndLoad(ctx, userID, nodeID)
	if err != nil {
		return err
	}
	if !validIface(name) {
		return ErrBadIface
	}
	if err := m.validatePeerReq(p); err != nil {
		return err
	}
	cfg, err := m.loadConf(ctx, node, cred, name)
	if err != nil {
		return err
	}
	idx := findPeer(cfg, p.PublicKey)
	if idx < 0 {
		return ErrPeerNotFound
	}
	// Preserve the existing comment unless a new one is supplied.
	np := peerConfigFromReq(p)
	if np.Comment == "" {
		np.Comment = cfg.Peers[idx].Comment
	}
	cfg.Peers[idx] = np
	if err := m.persistAndSync(ctx, node, cred, name, cfg, p, false); err != nil {
		return err
	}
	m.invalidate(nodeID)
	m.recordAudit(claims, nodeID, fmt.Sprintf("wireguard update peer %s iface=%s allowed=%s", keyFP(p.PublicKey), name, strings.Join(p.AllowedIPs, ",")))
	return nil
}

// DeletePeer removes a peer from <name>: removed live + from the conf. Gated by
// wireguard:manage.
func (m *Manager) DeletePeer(ctx context.Context, userID, nodeID uint64, claims AuditClaims, name, pubKey string) error {
	node, cred, err := m.gateAndLoad(ctx, userID, nodeID)
	if err != nil {
		return err
	}
	if !validIface(name) {
		return ErrBadIface
	}
	if !validWGKey(pubKey) {
		return ErrBadKey
	}
	cfg, err := m.loadConf(ctx, node, cred, name)
	if err != nil {
		return err
	}
	idx := findPeer(cfg, pubKey)
	if idx < 0 {
		return ErrPeerNotFound
	}
	cfg.Peers = append(cfg.Peers[:idx], cfg.Peers[idx+1:]...)
	if _, err := m.writeConfRaw(ctx, node, cred, name, renderConf(cfg), ""); err != nil {
		return err
	}
	// Live removal (best effort — interface may be down).
	cmd := fmt.Sprintf("sudo -n sh -c 'wg show %s >/dev/null 2>&1 && wg set %s peer %s remove || echo __IFACE_DOWN__' 2>&1 || sh -c 'wg show %s >/dev/null 2>&1 && wg set %s peer %s remove || echo __IFACE_DOWN__' 2>&1",
		shellQuote(name), shellQuote(name), shellQuote(pubKey), shellQuote(name), shellQuote(name), shellQuote(pubKey))
	if _, err := m.runWG(ctx, node, cred, cmd, "wg set remove", m.cfg.SSHTimeout); err != nil {
		return err
	}
	m.invalidate(nodeID)
	m.recordAudit(claims, nodeID, fmt.Sprintf("wireguard remove peer %s iface=%s", keyFP(pubKey), name))
	return nil
}

// ApplyConfig makes the on-disk conf live, streaming output line-by-line. sync
// uses `wg syncconf` (no tunnel drop, picks up peer/port changes); reload uses
// wg-quick down && up (brief drop, needed for Address/MTU changes). Gated by
// wireguard:manage.
func (m *Manager) ApplyConfig(ctx context.Context, userID, nodeID uint64, claims AuditClaims, name string, mode ApplyMode, emit func(string)) error {
	node, cred, err := m.gateAndLoad(ctx, userID, nodeID)
	if err != nil {
		return err
	}
	if !validIface(name) {
		return ErrBadIface
	}
	q := shellQuote(name)
	var inner string
	switch mode {
	case ApplyReload:
		inner = fmt.Sprintf(`echo "重载接口 %s …"; wg-quick down %s 2>&1 || true; wg-quick up %s 2>&1; echo "===DONE rc=$?==="`, name, q, q)
	default: // ApplySync
		inner = fmt.Sprintf(`echo "热同步接口 %s …"; T=$(mktemp); wg-quick strip %s > "$T" 2>&1 && wg syncconf %s "$T" 2>&1; rc=$?; rm -f "$T"; echo "===DONE rc=$rc==="; exit $rc`, name, q, q)
	}
	cmd := fmt.Sprintf("sudo -n sh -c '%s' 2>&1 || sh -c '%s' 2>&1", inner, inner)
	err = sshrun.RunStream(ctx, m.deps, node, cred, cmd, m.cfg.SSHTimeout, emit)
	m.invalidate(nodeID)
	m.recordAudit(claims, nodeID, fmt.Sprintf("wireguard apply %s mode=%s", name, modeWord(mode)))
	return err
}

// ---- shared peer helpers ----

// loadConf reads + parses <name>.conf (unmasked, for re-rendering).
func (m *Manager) loadConf(ctx context.Context, node *model.Node, cred *model.Credential, name string) (*IfaceConfig, error) {
	content, exists, err := m.readConfRaw(ctx, node, cred, name)
	if err != nil {
		return nil, err
	}
	if !exists {
		return nil, ErrConfNotFound
	}
	return parseConf(name, content)
}

// persistAndSync writes the updated conf, then applies the single peer live via
// `wg set` (best effort — skipped when the interface is down). isClient is
// unused today but kept for symmetry with the client flow.
func (m *Manager) persistAndSync(ctx context.Context, node *model.Node, cred *model.Credential, name string, cfg *IfaceConfig, p PeerReq, _ bool) error {
	if _, err := m.writeConfRaw(ctx, node, cred, name, renderConf(cfg), ""); err != nil {
		return err
	}
	_, err := m.runWG(ctx, node, cred, m.liveSetPeerCmd(name, p), "wg set", m.cfg.SSHTimeout)
	return err
}

// liveSetPeerCmd builds the `wg set` command that applies one peer live. The
// preshared key (if any) is decoded from base64 into a temp file so it never
// appears on the command line, and is removed afterwards. The whole thing is a
// no-op (prints __IFACE_DOWN__) when the interface isn't up.
func (m *Manager) liveSetPeerCmd(name string, p PeerReq) string {
	q := shellQuote(name)
	pub := shellQuote(p.PublicKey)
	aips := shellQuote(strings.Join(p.AllowedIPs, ","))
	set := fmt.Sprintf("wg set %s peer %s allowed-ips %s", q, pub, aips)
	if p.Endpoint != "" {
		set += " endpoint " + shellQuote(p.Endpoint)
	}
	if p.PersistentKeepalive > 0 {
		set += fmt.Sprintf(" persistent-keepalive %d", p.PersistentKeepalive)
	}
	var inner string
	if p.PresharedKey != "" {
		b64 := base64.StdEncoding.EncodeToString([]byte(p.PresharedKey))
		inner = fmt.Sprintf(`if wg show %s >/dev/null 2>&1; then T=$(mktemp); printf %%s "%s" | base64 -d > "$T"; %s preshared-key "$T"; rc=$?; rm -f "$T"; exit $rc; else echo __IFACE_DOWN__; fi`,
			q, b64, set)
	} else {
		inner = fmt.Sprintf(`if wg show %s >/dev/null 2>&1; then %s; else echo __IFACE_DOWN__; fi`, q, set)
	}
	return fmt.Sprintf("sudo -n sh -c '%s' 2>&1 || sh -c '%s' 2>&1", inner, inner)
}

func peerConfigFromReq(p PeerReq) PeerConfig {
	return PeerConfig{
		PublicKey:           p.PublicKey,
		PresharedKey:        p.PresharedKey,
		AllowedIPs:          p.AllowedIPs,
		Endpoint:            p.Endpoint,
		PersistentKeepalive: p.PersistentKeepalive,
		Comment:             p.Comment,
	}
}

func findPeer(cfg *IfaceConfig, pubKey string) int {
	for i := range cfg.Peers {
		if cfg.Peers[i].PublicKey == pubKey {
			return i
		}
	}
	return -1
}

// keyFP returns a short fingerprint of a key for audit logs (never the whole
// key, never a private key).
func keyFP(k string) string {
	k = strings.TrimSpace(k)
	if len(k) <= 8 {
		return k
	}
	return k[:8] + "…"
}

func modeWord(m ApplyMode) string {
	if m == ApplyReload {
		return "reload"
	}
	return "sync"
}
