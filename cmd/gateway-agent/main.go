// Command gateway-agent is the reverse-connect Gateway Agent: a single static
// binary deployed inside an isolated network. It only ever connects OUTBOUND to
// the JumpServer gateway (it never listens), runs the agent side of the yamux
// tunnel, and dials targets on the gateway's behalf. See
// docs/security-architecture.md §4.
//
// Usage:
//
//	gateway-agent enroll --server wss://bastion:8443 --token <OTT> [--name edge-1]
//	gateway-agent run     --server wss://bastion:8443            [--state /var/lib/gateway-agent]
//
// enroll consumes a one-time token, registers this host as an agent, and writes
// an identity file. run loads that identity and maintains the tunnel with
// automatic reconnect. M2 uses a bearer secret for tunnel auth; M3 replaces it
// with mTLS client certificates.
package main

import (
	"bytes"
	"context"
	"crypto/x509"
	"encoding/json"
	"encoding/pem"
	"flag"
	"fmt"
	"net"
	"net/http"
	"os"
	"os/signal"
	"path/filepath"
	"strings"
	"syscall"
	"time"

	"github.com/coder/websocket"
	"github.com/michongs/jumpserver-anonymous/internal/agentgw"
	"github.com/michongs/jumpserver-anonymous/internal/pki"
)

const identityFile = "identity.json"

// version is stamped into enroll/heartbeat so the gateway can show which agent
// build is connected. It must be a var (not a const) for
// `-ldflags -X main.version=…` to take effect — build-agent.sh stamps the git
// describe output here.
var version = "dev"

// identity is the persisted result of enrollment. The agent authenticates the
// tunnel with its mTLS client certificate (KeyPEM/CertPEM), pinning the gateway
// via CABundle as RootCAs.
type identity struct {
	AgentID  uint64 `json:"agent_id"`
	DomainID uint64 `json:"domain_id"`
	KeyPEM   string `json:"key_pem"`
	CertPEM  string `json:"cert_pem"`
	CABundle string `json:"ca_bundle"`
	Server   string `json:"server"`
	Name     string `json:"name"`
}

func main() {
	if len(os.Args) < 2 {
		usage()
		os.Exit(2)
	}
	switch os.Args[1] {
	case "enroll":
		if err := runEnroll(os.Args[2:]); err != nil {
			fmt.Fprintln(os.Stderr, "enroll:", err)
			os.Exit(1)
		}
	case "run":
		if err := runAgent(os.Args[2:]); err != nil {
			fmt.Fprintln(os.Stderr, "run:", err)
			os.Exit(1)
		}
	case "-h", "--help", "help":
		usage()
	default:
		fmt.Fprintf(os.Stderr, "unknown command %q\n", os.Args[1])
		usage()
		os.Exit(2)
	}
}

func usage() {
	fmt.Fprint(os.Stderr, `gateway-agent — reverse-connect JumpServer agent

  gateway-agent enroll --server wss://host:8443 --token <OTT> [--name NAME] [--state DIR]
  gateway-agent run    --server wss://host:8443                [--state DIR]
`)
}

func runEnroll(args []string) error {
	fs := flag.NewFlagSet("enroll", flag.ExitOnError)
	server := fs.String("server", "", "gateway base URL, e.g. wss://bastion:8443")
	token := fs.String("token", "", "one-time enrollment token")
	name := fs.String("name", "", "agent display name (default: hostname)")
	stateDir := fs.String("state", defaultStateDir(), "directory for the identity file")
	force := fs.Bool("force", false, "replace an existing identity in --state instead of refusing")
	_ = fs.Parse(args)

	if *server == "" || *token == "" {
		return fmt.Errorf("--server and --token are required")
	}
	// Deploying MANY agents is first-class — several in one domain load-balance and
	// fail over (HA), or run one per isolated network — but each needs its OWN
	// --state dir. Refuse to clobber an existing identity: re-enrolling into the
	// same dir would overwrite the previous agent's key+cert and orphan its
	// gateway-side row. --force is the deliberate "re-enroll this one" escape.
	if !*force {
		if existing, lerr := loadIdentity(*stateDir); lerr == nil && existing != nil {
			return fmt.Errorf(
				"agent identity already exists in %s (agent #%d %q).\n"+
					"  deploy ANOTHER agent on this host: re-run with a separate --state DIR\n"+
					"  re-enroll THIS agent from scratch: add --force",
				*stateDir, existing.AgentID, existing.Name)
		}
	}
	agentName := *name
	if agentName == "" {
		agentName, _ = os.Hostname()
	}

	// Generate our keypair + CSR locally. The private key never leaves this host.
	keyPEM, csrPEM, err := pki.GenerateKeyAndCSR(agentName)
	if err != nil {
		return fmt.Errorf("generate key/csr: %w", err)
	}
	body, _ := json.Marshal(map[string]string{
		"token": *token, "name": agentName, "version": version, "csr_pem": string(csrPEM),
	})
	ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
	defer cancel()
	req, err := http.NewRequestWithContext(ctx, http.MethodPost, httpBase(*server)+"/agent/v1/enroll", bytes.NewReader(body))
	if err != nil {
		return err
	}
	req.Header.Set("Content-Type", "application/json")
	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		return fmt.Errorf("reach gateway: %w", err)
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK && resp.StatusCode != http.StatusCreated {
		return fmt.Errorf("gateway rejected enrollment: %s", resp.Status)
	}
	var er struct {
		AgentID  uint64 `json:"agent_id"`
		DomainID uint64 `json:"domain_id"`
		CertPEM  string `json:"cert_pem"`
		CABundle string `json:"ca_bundle"`
	}
	if err := json.NewDecoder(resp.Body).Decode(&er); err != nil {
		return fmt.Errorf("decode enroll response: %w", err)
	}
	if er.CertPEM == "" || er.CABundle == "" {
		return fmt.Errorf("gateway did not return a certificate")
	}
	id := &identity{
		AgentID: er.AgentID, DomainID: er.DomainID,
		KeyPEM: string(keyPEM), CertPEM: er.CertPEM, CABundle: er.CABundle,
		Server: *server, Name: agentName,
	}
	if err := saveIdentity(*stateDir, id); err != nil {
		return err
	}
	fmt.Printf("enrolled as agent #%d in domain #%d (%s)\n", id.AgentID, id.DomainID, agentName)
	fmt.Printf("identity written to %s — now run: gateway-agent run --server %s --state %s\n",
		filepath.Join(*stateDir, identityFile), *server, *stateDir)
	fmt.Println("note: the agent stays PENDING until an administrator activates it in the console.")
	return nil
}

func runAgent(args []string) error {
	fs := flag.NewFlagSet("run", flag.ExitOnError)
	server := fs.String("server", "", "gateway base URL (default: from identity file)")
	stateDir := fs.String("state", defaultStateDir(), "directory holding the identity file")
	_ = fs.Parse(args)

	id, err := loadIdentity(*stateDir)
	if err != nil {
		return fmt.Errorf("load identity (did you enroll?): %w", err)
	}
	if *server != "" {
		id.Server = *server
	}
	if id.Server == "" {
		return fmt.Errorf("no server URL (enroll first or pass --server)")
	}

	ctx, stop := signal.NotifyContext(context.Background(), syscall.SIGINT, syscall.SIGTERM)
	defer stop()

	fmt.Printf("gateway-agent %s starting: agent #%d, domain #%d → %s\n",
		version, id.AgentID, id.DomainID, id.Server)

	backoff := time.Second
	const maxBackoff = 60 * time.Second
	for ctx.Err() == nil {
		// Rotate the client certificate before it lapses so a long-lived agent
		// never dies of expiry. Non-fatal: if renewal fails (e.g. agent not yet
		// activated) we still try to connect with the current cert.
		if err := renewIfNeeded(ctx, id, *stateDir); err != nil {
			fmt.Fprintf(os.Stderr, "certificate renewal: %v\n", err)
		}
		err := connectOnce(ctx, id)
		if ctx.Err() != nil {
			break
		}
		if err != nil {
			fmt.Fprintf(os.Stderr, "tunnel ended: %v — reconnecting in %s\n", err, backoff)
		}
		select {
		case <-ctx.Done():
		case <-time.After(jitter(backoff)):
		}
		if backoff < maxBackoff {
			backoff *= 2
			if backoff > maxBackoff {
				backoff = maxBackoff
			}
		}
		// Reset backoff after a long-lived connection would require tracking
		// connect time; keep it simple — a clean run resets it below.
	}
	fmt.Println("gateway-agent stopped")
	return nil
}

// connectOnce establishes a single tunnel (authenticated by the agent's mTLS
// client certificate) and serves it until it drops.
func connectOnce(ctx context.Context, id *identity) error {
	tlsCfg, err := pki.ClientTLSConfig([]byte(id.CertPEM), []byte(id.KeyPEM), []byte(id.CABundle), hostOf(id.Server))
	if err != nil {
		return fmt.Errorf("build client tls: %w", err)
	}
	dialCtx, cancel := context.WithTimeout(ctx, 30*time.Second)
	defer cancel()
	wsURL := wsBase(id.Server) + "/agent/v1/tunnel"
	conn, _, err := websocket.Dial(dialCtx, wsURL, &websocket.DialOptions{
		HTTPClient: &http.Client{Transport: &http.Transport{TLSClientConfig: tlsCfg}},
		HTTPHeader: http.Header{"X-Agent-Version": {version}},
	})
	if err != nil {
		return fmt.Errorf("dial tunnel: %w", err)
	}
	// Unlimited read size — tunnelled session bytes are large; framing is yamux's.
	conn.SetReadLimit(-1)
	netConn := websocket.NetConn(ctx, conn, websocket.MessageBinary)

	fmt.Println("tunnel established")
	serveErr := agentgw.ServeAgent(ctx, netConn, agentgw.AgentServeOptions{})
	_ = conn.Close(websocket.StatusNormalClosure, "bye")
	return serveErr
}

// renewIfNeeded rotates the client certificate when it has spent more than
// two-thirds of its lifetime, mutating id in place and persisting it. A no-op
// when the cert is still fresh or unparseable.
func renewIfNeeded(ctx context.Context, id *identity, stateDir string) error {
	blk, _ := pem.Decode([]byte(id.CertPEM))
	if blk == nil {
		return nil
	}
	cert, err := x509.ParseCertificate(blk.Bytes)
	if err != nil {
		return nil
	}
	total := cert.NotAfter.Sub(cert.NotBefore)
	if total <= 0 {
		return nil
	}
	// Renew once less than a third of the lifetime remains.
	if time.Until(cert.NotAfter) > total/3 {
		return nil
	}
	return renewCert(ctx, id, stateDir)
}

// renewCert obtains a fresh certificate over an mTLS POST authenticated by the
// CURRENT certificate, then swaps the agent's key/cert/bundle and saves.
func renewCert(ctx context.Context, id *identity, stateDir string) error {
	keyPEM, csrPEM, err := pki.GenerateKeyAndCSR(id.Name)
	if err != nil {
		return err
	}
	tlsCfg, err := pki.ClientTLSConfig([]byte(id.CertPEM), []byte(id.KeyPEM), []byte(id.CABundle), hostOf(id.Server))
	if err != nil {
		return err
	}
	rctx, cancel := context.WithTimeout(ctx, 30*time.Second)
	defer cancel()
	body, _ := json.Marshal(map[string]string{"csr_pem": string(csrPEM)})
	req, err := http.NewRequestWithContext(rctx, http.MethodPost, httpBase(id.Server)+"/agent/v1/renew", bytes.NewReader(body))
	if err != nil {
		return err
	}
	req.Header.Set("Content-Type", "application/json")
	client := &http.Client{Transport: &http.Transport{TLSClientConfig: tlsCfg}}
	resp, err := client.Do(req)
	if err != nil {
		return fmt.Errorf("renew request: %w", err)
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		return fmt.Errorf("gateway rejected renewal: %s", resp.Status)
	}
	var rr struct {
		CertPEM  string `json:"cert_pem"`
		CABundle string `json:"ca_bundle"`
	}
	if err := json.NewDecoder(resp.Body).Decode(&rr); err != nil {
		return err
	}
	if rr.CertPEM == "" {
		return fmt.Errorf("renewal returned no certificate")
	}
	id.KeyPEM = string(keyPEM)
	id.CertPEM = rr.CertPEM
	if rr.CABundle != "" {
		id.CABundle = rr.CABundle
	}
	if err := saveIdentity(stateDir, id); err != nil {
		return err
	}
	fmt.Println("client certificate renewed")
	return nil
}

// ---- identity persistence ----

func saveIdentity(dir string, id *identity) error {
	if err := os.MkdirAll(dir, 0o700); err != nil {
		return err
	}
	data, err := json.MarshalIndent(id, "", "  ")
	if err != nil {
		return err
	}
	// 0600 — the secret is sensitive.
	return os.WriteFile(filepath.Join(dir, identityFile), data, 0o600)
}

func loadIdentity(dir string) (*identity, error) {
	data, err := os.ReadFile(filepath.Join(dir, identityFile))
	if err != nil {
		return nil, err
	}
	var id identity
	if err := json.Unmarshal(data, &id); err != nil {
		return nil, err
	}
	return &id, nil
}

func defaultStateDir() string {
	if v := os.Getenv("GATEWAY_AGENT_STATE"); v != "" {
		return v
	}
	return "/var/lib/gateway-agent"
}

// ---- URL helpers ----

// wsBase normalises a base URL to a ws/wss scheme.
func wsBase(s string) string {
	s = strings.TrimRight(s, "/")
	switch {
	case strings.HasPrefix(s, "http://"):
		return "ws://" + strings.TrimPrefix(s, "http://")
	case strings.HasPrefix(s, "https://"):
		return "wss://" + strings.TrimPrefix(s, "https://")
	default:
		return s
	}
}

// hostOf extracts the hostname (no scheme, no port) from a base URL, for the
// TLS ServerName the agent verifies the gateway's server cert against.
func hostOf(s string) string {
	s = strings.TrimRight(s, "/")
	for _, p := range []string{"wss://", "ws://", "https://", "http://"} {
		s = strings.TrimPrefix(s, p)
	}
	if i := strings.IndexByte(s, '/'); i >= 0 {
		s = s[:i]
	}
	if h, _, err := net.SplitHostPort(s); err == nil {
		return h
	}
	return s
}

// httpBase normalises a base URL to an http/https scheme (for the enroll POST).
func httpBase(s string) string {
	s = strings.TrimRight(s, "/")
	switch {
	case strings.HasPrefix(s, "ws://"):
		return "http://" + strings.TrimPrefix(s, "ws://")
	case strings.HasPrefix(s, "wss://"):
		return "https://" + strings.TrimPrefix(s, "wss://")
	default:
		return s
	}
}

// jitter spreads reconnect attempts so a fleet doesn't thunder the gateway.
func jitter(d time.Duration) time.Duration {
	// Deterministic ±12.5% based on the wall clock nanosecond — no rand import.
	n := time.Now().UnixNano() % int64(d/4+1)
	return d - d/8 + time.Duration(n)
}
