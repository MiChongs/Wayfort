package wireguard

import (
	"context"
	"fmt"
	"strings"
)

// client.go implements one-click client onboarding: generate a client key pair,
// auto-allocate the next free address in the interface subnet, register the
// client as a server peer (live + persisted), and render a ready-to-import
// client .conf the UI turns into a QR code. The client private key is returned
// exactly once (no-store) and never stored or logged.

// ClientReq parameterises a new client config.
type ClientReq struct {
	Comment    string   `json:"comment"`     // friendly name, stored as a peer "# Name =" alias
	DNS        []string `json:"dns"`         // client DNS; defaults to the interface DNS
	AllowedIPs []string `json:"allowed_ips"` // client-side routes; defaults to full tunnel
	Endpoint   string   `json:"endpoint"`    // public host/IP for the client to reach; defaults to node host
	Keepalive  int      `json:"persistent_keepalive"`
	UsePSK     bool     `json:"use_psk"`
}

// ClientConfig is the generated client onboarding bundle.
type ClientConfig struct {
	InterfaceName   string `json:"interface_name"`
	Address         string `json:"address"`
	PublicKey       string `json:"public_key"`        // client public key (now a server peer)
	ServerPublicKey string `json:"server_public_key"` // derived from the interface key
	Endpoint        string `json:"endpoint"`
	DNS             string `json:"dns,omitempty"`
	AllowedIPs      string `json:"allowed_ips"`
	Keepalive       int    `json:"persistent_keepalive,omitempty"`
	Conf            string `json:"conf"` // full client .conf — the UI renders this as a QR
}

// NewClient creates a peer for a new client and returns its ready-to-use config.
// Gated by wireguard:manage.
func (m *Manager) NewClient(ctx context.Context, userID, nodeID uint64, claims AuditClaims, name string, req ClientReq) (*ClientConfig, error) {
	node, cred, err := m.gateAndLoad(ctx, userID, nodeID)
	if err != nil {
		return nil, err
	}
	if !validIface(name) {
		return nil, ErrBadIface
	}
	if !validKeepalive(req.Keepalive) {
		return nil, ErrBadKeepalive
	}
	if len(req.AllowedIPs) > 0 && !validAllowedIPs(req.AllowedIPs) {
		return nil, ErrBadAllowedIPs
	}
	if req.Endpoint != "" && !validHostIP(req.Endpoint) && !validHostname(req.Endpoint) {
		return nil, ErrBadEndpoint
	}

	cfg, err := m.loadConf(ctx, node, cred, name)
	if err != nil {
		return nil, err
	}
	if len(cfg.Address) == 0 {
		return nil, ErrBadCIDR // interface has no subnet to allocate from
	}
	serverPub, err := m.pubFromPriv(ctx, node, cred, cfg.PrivateKey)
	if err != nil {
		return nil, err
	}

	// Allocate the next free host address in the interface subnet.
	taken := make([]string, 0, len(cfg.Peers))
	for _, p := range cfg.Peers {
		taken = append(taken, p.AllowedIPs...)
	}
	addr, err := nextFreeIP(cfg.Address, taken)
	if err != nil {
		return nil, err
	}
	hostCIDR := addr.String() + "/32"
	if addr.Is6() {
		hostCIDR = addr.String() + "/128"
	}

	clientKP, err := m.genKeyPair(ctx, node, cred)
	if err != nil {
		return nil, err
	}
	psk := ""
	if req.UsePSK {
		if psk, err = m.genPSK(ctx, node, cred); err != nil {
			return nil, err
		}
	}

	// Register the client as a server peer (persist + live).
	peer := PeerReq{
		PublicKey:    clientKP.PublicKey,
		AllowedIPs:   []string{hostCIDR},
		PresharedKey: psk,
		Comment:      req.Comment,
	}
	cfg.Peers = append(cfg.Peers, peerConfigFromReq(peer))
	if err := m.persistAndSync(ctx, node, cred, name, cfg, peer, true); err != nil {
		return nil, err
	}

	// Build the client-side config.
	host := req.Endpoint
	if host == "" {
		host = node.Host
	}
	endpoint := fmt.Sprintf("%s:%d", host, cfg.ListenPort)
	allowed := "0.0.0.0/0, ::/0"
	if len(req.AllowedIPs) > 0 {
		allowed = strings.Join(req.AllowedIPs, ", ")
	}
	dns := strings.Join(req.DNS, ", ")
	if dns == "" {
		dns = strings.Join(cfg.DNS, ", ")
	}
	if dns == "" {
		// Server interfaces don't carry DNS; give the client a sane default so
		// full-tunnel clients still resolve names.
		dns = "1.1.1.1"
	}
	keepalive := req.Keepalive
	if keepalive == 0 {
		keepalive = 25
	}

	cc := &ClientConfig{
		InterfaceName: name, Address: hostCIDR,
		PublicKey: clientKP.PublicKey, ServerPublicKey: serverPub,
		Endpoint: endpoint, DNS: dns, AllowedIPs: allowed, Keepalive: keepalive,
	}
	cc.Conf = renderClientConf(clientKP.PrivateKey, psk, cc)

	m.invalidate(nodeID)
	m.recordAudit(claims, nodeID, fmt.Sprintf("wireguard new client %s iface=%s ip=%s", keyFP(clientKP.PublicKey), name, hostCIDR))
	return cc, nil
}

// renderClientConf produces the importable client .conf text.
func renderClientConf(privKey, psk string, cc *ClientConfig) string {
	var b strings.Builder
	b.WriteString("[Interface]\n")
	fmt.Fprintf(&b, "PrivateKey = %s\n", privKey)
	fmt.Fprintf(&b, "Address = %s\n", cc.Address)
	if cc.DNS != "" {
		fmt.Fprintf(&b, "DNS = %s\n", cc.DNS)
	}
	b.WriteString("\n[Peer]\n")
	fmt.Fprintf(&b, "PublicKey = %s\n", cc.ServerPublicKey)
	if psk != "" {
		fmt.Fprintf(&b, "PresharedKey = %s\n", psk)
	}
	fmt.Fprintf(&b, "Endpoint = %s\n", cc.Endpoint)
	fmt.Fprintf(&b, "AllowedIPs = %s\n", cc.AllowedIPs)
	if cc.Keepalive > 0 {
		fmt.Fprintf(&b, "PersistentKeepalive = %d\n", cc.Keepalive)
	}
	return b.String()
}
