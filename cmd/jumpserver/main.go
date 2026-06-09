package main

import (
	"context"
	cryptorand "crypto/rand"
	"flag"
	"fmt"
	"os"
	"os/exec"
	"os/signal"
	"path/filepath"
	"runtime"
	"strconv"
	"syscall"
	"time"

	"github.com/michongs/jumpserver-anonymous/internal/ai"
	"github.com/michongs/jumpserver-anonymous/internal/ai/optools"
	"github.com/michongs/jumpserver-anonymous/internal/anomaly"
	"github.com/michongs/jumpserver-anonymous/internal/anonymous"
	"github.com/michongs/jumpserver-anonymous/internal/api"
	"github.com/michongs/jumpserver-anonymous/internal/approval"
	"github.com/michongs/jumpserver-anonymous/internal/asset"
	"github.com/michongs/jumpserver-anonymous/internal/audit"
	"github.com/michongs/jumpserver-anonymous/internal/auth"
	"github.com/michongs/jumpserver-anonymous/internal/backup"
	"github.com/michongs/jumpserver-anonymous/internal/cache"
	"github.com/michongs/jumpserver-anonymous/internal/capture"
	"github.com/michongs/jumpserver-anonymous/internal/config"
	"github.com/michongs/jumpserver-anonymous/internal/cron"
	"github.com/michongs/jumpserver-anonymous/internal/dbquery"
	"github.com/michongs/jumpserver-anonymous/internal/desktop"
	"github.com/michongs/jumpserver-anonymous/internal/dialer"
	dockerpkg "github.com/michongs/jumpserver-anonymous/internal/docker"
	"github.com/michongs/jumpserver-anonymous/internal/files"
	"github.com/michongs/jumpserver-anonymous/internal/firewall"
	"github.com/michongs/jumpserver-anonymous/internal/hardware"
	"github.com/michongs/jumpserver-anonymous/internal/health"
	"github.com/michongs/jumpserver-anonymous/internal/insights"
	"github.com/michongs/jumpserver-anonymous/internal/kernel"
	"github.com/michongs/jumpserver-anonymous/internal/livewatch"
	"github.com/michongs/jumpserver-anonymous/internal/loganalytics"
	"github.com/michongs/jumpserver-anonymous/internal/logs"
	"github.com/michongs/jumpserver-anonymous/internal/metrics"
	"github.com/michongs/jumpserver-anonymous/internal/mfa"
	"github.com/michongs/jumpserver-anonymous/internal/model"
	"github.com/michongs/jumpserver-anonymous/internal/nettools"
	"github.com/michongs/jumpserver-anonymous/internal/notify"
	"github.com/michongs/jumpserver-anonymous/internal/office"
	"github.com/michongs/jumpserver-anonymous/internal/passkey"
	"github.com/michongs/jumpserver-anonymous/internal/perf"
	pkg "github.com/michongs/jumpserver-anonymous/internal/pkg"
	"github.com/michongs/jumpserver-anonymous/internal/process"
	"github.com/michongs/jumpserver-anonymous/internal/protocols/dbcli"
	"github.com/michongs/jumpserver-anonymous/internal/protocols/guacamole"
	"github.com/michongs/jumpserver-anonymous/internal/protocols/oss"
	"github.com/michongs/jumpserver-anonymous/internal/protocols/tcpfwd"
	"github.com/michongs/jumpserver-anonymous/internal/repo"
	"github.com/michongs/jumpserver-anonymous/internal/secaudit"
	"github.com/michongs/jumpserver-anonymous/internal/secrets"
	"github.com/michongs/jumpserver-anonymous/internal/server"
	"github.com/michongs/jumpserver-anonymous/internal/sesswin"
	"github.com/michongs/jumpserver-anonymous/internal/settings"
	"github.com/michongs/jumpserver-anonymous/internal/sftp"
	pkgssh "github.com/michongs/jumpserver-anonymous/internal/ssh"
	"github.com/michongs/jumpserver-anonymous/internal/sshpool"
	"github.com/michongs/jumpserver-anonymous/internal/sshrun"
	"github.com/michongs/jumpserver-anonymous/internal/storage"
	"github.com/michongs/jumpserver-anonymous/internal/systemd"
	"github.com/michongs/jumpserver-anonymous/internal/sysuser"
	"github.com/michongs/jumpserver-anonymous/internal/webssh"
	"github.com/michongs/jumpserver-anonymous/internal/wireguard"
	pkgcrypto "github.com/michongs/jumpserver-anonymous/pkg/crypto"
	"github.com/michongs/jumpserver-anonymous/pkg/kms"
	pkglog "github.com/michongs/jumpserver-anonymous/pkg/log"
	"go.uber.org/zap"
	"golang.org/x/net/proxy"
	"golang.org/x/sync/errgroup"
)

func main() {
	cfgPath := flag.String("config", "", "path to config file (default ./configs/config.yaml)")
	flag.Parse()

	cfg, err := config.Load(*cfgPath)
	if err != nil {
		fmt.Fprintln(os.Stderr, "load config:", err)
		os.Exit(1)
	}
	logger, err := pkglog.New(false)
	if err != nil {
		fmt.Fprintln(os.Stderr, "init log:", err)
		os.Exit(1)
	}
	defer logger.Sync() //nolint:errcheck

	if err := run(cfg, logger); err != nil {
		logger.Fatal("server exited", zap.Error(err))
	}
}

func run(cfg *config.Config, logger *zap.Logger) error {
	rootCtx, cancel := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
	defer cancel()

	db, err := repo.Open(cfg.DB)
	if err != nil {
		return fmt.Errorf("open db: %w", err)
	}
	if err := repo.AutoMigrate(db); err != nil {
		return fmt.Errorf("automigrate: %w", err)
	}
	// Make pre-existing org data consistent with the tree + multi-department
	// model (self-paths for groups, legacy department_id → user_departments).
	if err := repo.BackfillOrg(rootCtx, db); err != nil {
		return fmt.Errorf("backfill org: %w", err)
	}

	// Phase 14 — bootstrap the envelope-encryption layer. This:
	//   * reads (or mints) the bootstrap passphrase from
	//     cfg.Crypto.UnsealPassphraseFile (0600 file, never an env var
	//     or YAML field)
	//   * stretches it via Argon2id into a key that unseals the
	//     KMS-provider auth ciphertexts stored in the DB
	//   * resolves the primary KMSProvider row (or creates a default
	//     Local one on first boot) and runs a healthcheck
	//
	// The returned `secretsBoot.Service` is the envelope service the
	// rest of the gateway hangs per-owner Vault adapters off.
	secretsBoot, err := secrets.Bootstrap(rootCtx, secrets.BootstrapDeps{
		SealRepo:       repo.NewKMSSealRepo(db),
		ProviderRepo:   repo.NewKMSProviderRepo(db),
		EnvelopeRepo:   repo.NewSecretEnvelopeRepo(db),
		AuditRepo:      repo.NewSecretAuditRepo(db),
		Logger:         logger,
		UnsealFilePath: cfg.Crypto.UnsealPassphraseFile,
	})
	if err != nil {
		return fmt.Errorf("secrets bootstrap: %w", err)
	}
	logger.Info("secrets bootstrap ok",
		zap.String("primary_kms", string(secretsBoot.PrimaryRow.Kind)),
		zap.String("primary_kms_name", secretsBoot.PrimaryRow.Name),
		zap.Bool("fresh_install", secretsBoot.FreshInstall))

	// System settings center — overlay DB-persisted overrides onto the YAML
	// defaults and republish the effective config. From here on `cfg` is the
	// effective snapshot, so every subsystem below wires from the runtime
	// values a super-admin set in the UI (not the raw YAML). Bootstrap-only
	// keys (server/db/redis/jwt/crypto/listeners) are never managed here.
	settingsRepo := repo.NewSystemSettingRepo(db)
	settingsCenter, err := settings.New(rootCtx, cfg, settingsRepo, secretsBoot.Unsealer, logger)
	if err != nil {
		return fmt.Errorf("settings center: %w", err)
	}
	cfg = settingsCenter.Snapshot()
	settingsProber := settings.NewProber(settingsCenter)

	// One pkg/crypto.Vault per call-site OwnerType. Each adapter
	// records its own envelope rows so audit + rotation can target
	// specific credential families.
	credentialVault := secretsBoot.NewVaultFor(model.OwnerCredentialSecret)
	oidcVault := secretsBoot.NewVaultFor(model.OwnerOIDCClientSecret)
	mfaVault := secretsBoot.NewVaultFor(model.OwnerUserMFASecret)
	aiVault := secretsBoot.NewVaultFor(model.OwnerAIProviderAPIKey)
	genericVault := secretsBoot.NewVaultFor(model.OwnerGeneric)

	// Legacy migration aid. When cfg.Crypto.MasterKeyHex is non-empty
	// the operator is mid-migration from Phase-13 single-master-key
	// AES-GCM ciphertexts; we attach the old Sealer so the envelope
	// adapter's Open() can fall through to it for pre-Phase-14 rows.
	if cfg.Crypto.MasterKeyHex != "" {
		legacy, err := pkgcrypto.NewSealer(cfg.Crypto.MasterKeyHex)
		if err != nil {
			return fmt.Errorf("legacy sealer: %w", err)
		}
		for _, v := range []pkgcrypto.Vault{credentialVault, oidcVault, mfaVault, aiVault, genericVault} {
			if ev, ok := v.(*secrets.EnvelopeVault); ok {
				ev.AttachLegacy(legacy)
			}
		}
		logger.Warn("legacy AES master key attached — pre-Phase-14 ciphertexts will decrypt; rotate to envelope mode then drop crypto.master_key_hex from config")
	}

	// `sealer` keeps the old variable name so the rest of the
	// wire-up reads unchanged where the single Vault still drives
	// multiple subsystems (guacamole, dbcli, desktop). credentialVault
	// is the right choice there because every plaintext those paths
	// open is the password byte slice from a credentials row.
	sealer := credentialVault
	_ = genericVault // reserved for /api/v1/setup/* and ad-hoc owners
	rc, err := cache.New(cfg.Redis)
	if err != nil {
		return fmt.Errorf("redis: %w", err)
	}
	defer rc.Close()

	userRepo := repo.NewUserRepo(db)
	nodeRepo := repo.NewNodeRepo(db)
	proxyRepo := repo.NewProxyRepo(db)
	// Phase 11 — terminal personalisation (snippets / history / per-user prefs)
	snippetRepo := repo.NewSnippetRepo(db)
	historyRepoTerm := repo.NewCommandHistoryRepo(db)
	terminalProfileRepo := repo.NewTerminalProfileRepo(db)
	// Phase 10 — saved proxy-chain templates for the visual builder.
	chainTemplateRepo := repo.NewChainTemplateRepo(db)
	sshKeyRepo := repo.NewSSHKeyRepo(db)
	knownHostRepo := repo.NewKnownHostRepo(db)
	bulkRunRepo := repo.NewBulkRunRepo(db)
	credRepo := repo.NewCredentialRepo(db)
	sessionRepo := repo.NewSessionRepo(db)
	auditRepo := repo.NewAuditRepo(db)
	roleRepo := repo.NewRoleRepo(db)
	deptRepo := repo.NewDepartmentRepo(db)
	groupRepo := repo.NewUserGroupRepo(db)
	mfaRepo := repo.NewUserMFARepo(db)
	recoveryRepo := repo.NewRecoveryCodeRepo(db)
	webauthnRepo := repo.NewWebauthnRepo(db)
	historyRepo := repo.NewLoginHistoryRepo(db)
	oidcRepo := repo.NewOIDCClientRepo(db)
	assetGroupRepo := repo.NewAssetGroupRepo(db)
	tagRepo := repo.NewTagRepo(db)
	tagGroupRepo := repo.NewTagGroupRepo(db)
	grantRepo := repo.NewGrantRepo(db)
	accessFolderRepo := repo.NewAccessFolderRepo(db)
	accessItemRepo := repo.NewAccessItemRepo(db)
	accessTemplateRepo := repo.NewAccessTemplateRepo(db)
	favoriteRepo := repo.NewFavoriteRepo(db)
	recentRepo := repo.NewRecentRepo(db)

	bootstrap, err := bootstrapAdmin(rootCtx, userRepo, cfg.Auth)
	if err != nil {
		return fmt.Errorf("bootstrap admin: %w", err)
	}
	if err := seedRBAC(rootCtx, roleRepo, userRepo, cfg.Auth.BootstrapAdmin); err != nil {
		return fmt.Errorf("seed rbac: %w", err)
	}
	// One-time, idempotent: lift legacy freetext node tags into the managed
	// colour-tag system so every node's labels become first-class, filterable,
	// grant-aware tags. Only touches nodes that have no managed tags yet.
	if migrated, err := tagRepo.MigrateFreetextNodeTags(rootCtx); err != nil {
		logger.Warn("freetext tag migration failed", zap.Error(err))
	} else if migrated > 0 {
		logger.Info("migrated freetext node tags to managed tags", zap.Int("nodes", migrated))
	}

	issuer := auth.NewIssuer(cfg.Auth.JWTSecret, cfg.Auth.AccessTTL, cfg.Auth.RefreshTTL)
	registry := auth.NewRegistry()
	registry.Register(auth.NewLocalProvider(userRepo))
	registry.Register(auth.NewOIDCProvider())

	// Auth security helpers
	blocklist := auth.NewBlocklist(rc.Client())
	lockout := auth.NewLockoutPolicy(rc.Client(), cfg.Auth.Lockout.Threshold, cfg.Auth.Lockout.Window, cfg.Auth.Lockout.Duration)
	rbacResolver := auth.NewResolver(userRepo, roleRepo, rc.Client())
	oidcManager := auth.NewOIDCManager(oidcRepo, rc.Client(), oidcVault)

	// MFA + Passkey
	totpSvc := mfa.NewTOTPService(cfg.Auth.MFA.TOTPIssuer, mfaRepo, mfaVault)
	recoverySvc := mfa.NewRecoveryService(recoveryRepo, cfg.Auth.MFA.RecoveryCodesCount)
	var mailer *notify.Mailer
	if cfg.Notify.SMTP.Host != "" {
		m, err := notify.New(notify.Config{
			Host: cfg.Notify.SMTP.Host, Port: cfg.Notify.SMTP.Port,
			Username: cfg.Notify.SMTP.Username, Password: cfg.Notify.SMTP.Password,
			From: cfg.Notify.SMTP.From, UseTLS: cfg.Notify.SMTP.TLS,
			ChanSize: cfg.Notify.Worker.ChanSize, MaxRetries: cfg.Notify.Worker.MaxRetries,
		}, logger)
		if err != nil {
			logger.Warn("smtp mailer disabled", zap.Error(err))
		} else {
			mailer = m
		}
	}
	emailOTP := mfa.NewEmailOTPService(rc.Client(), mailer, cfg.Auth.MFA.EmailOTPTTL, cfg.Auth.MFA.EmailOTPCooldown)
	var passkeySvc *passkey.Service
	if cfg.Auth.Passkey.Enabled {
		ps, err := passkey.New(passkey.Config{
			RPID: cfg.Auth.Passkey.RPID, RPDisplay: cfg.Auth.Passkey.RPDisplay,
			Origins: cfg.Auth.Passkey.Origins, Discoverable: cfg.Auth.Passkey.DiscoverableLogin,
		}, userRepo, webauthnRepo, rc.Client())
		if err != nil {
			logger.Warn("passkey disabled", zap.Error(err))
		} else {
			passkeySvc = ps
		}
	}
	var anomalyDetector *anomaly.Detector
	if cfg.Auth.Anomaly.Enabled {
		anomalyDetector = anomaly.New(historyRepo, mailer, logger, cfg.Auth.Anomaly.NotifyEmail)
	}
	assetResolver := asset.NewResolver(grantRepo, groupRepo, deptRepo, roleRepo, userRepo, assetGroupRepo, tagRepo, nodeRepo, accessFolderRepo, accessItemRepo, rc.Client())

	resolver := pkgssh.NewResolver(sealer)
	hostKeyChecker, err := pkgssh.NewHostKeyChecker("", false)
	if err != nil {
		return fmt.Errorf("host key checker: %w", err)
	}

	credProvider := &pkgssh.PoolCredentialProvider{Creds: credRepo, Resolver: resolver}
	pool := sshpool.New(cfg.SSHPool, credProvider, hostKeyChecker.Callback())
	proxyGroupRepo := repo.NewProxyGroupRepo(db)
	healthReg := health.NewRegistry(cfg.Health.DegradedMS)
	metricsReg := metrics.New()
	chain := &dialer.ChainBuilder{
		Bastion:           pool,
		Creds:             &pkgssh.SOCKS5CredentialResolver{Creds: credRepo, Resolver: resolver},
		Groups:            proxyGroupRepo,
		Health:            healthReg,
		Metrics:           metricsReg,
		DefaultHopTimeout: 15 * time.Second,
	}
	proxyProber := health.NewProber(healthReg, proxyRepo, chain, proxyGroupRepo, health.Config{
		Enabled:     cfg.Health.Enabled,
		Interval:    cfg.Health.Interval,
		Timeout:     cfg.Health.Timeout,
		Concurrency: cfg.Health.Concurrency,
		DegradedMS:  cfg.Health.DegradedMS,
		ProbeTarget: cfg.Health.ProbeTarget,
	}, logger)

	auditWriter := audit.NewWriter(cfg.Audit, auditRepo, logger)
	// Lifecycle v3 — connection-quality sample queue (RTT / loss / bandwidth /
	// reconnects). Batched to the DB through its own single worker like the
	// audit writer; sessions feed it via per-session MetricSinks.
	metricWriter := audit.NewMetricWriter(sessionRepo, logger)

	var anonService *anonymous.Service
	var anonJanitor *anonymous.Janitor
	if cfg.Anonymous.Enabled {
		launcher, err := anonymous.NewDockerLauncher(cfg.Anonymous)
		if err != nil {
			logger.Warn("docker init failed; anonymous disabled", zap.Error(err))
		} else {
			anonService = anonymous.NewService(launcher, rc, logger)
			anonJanitor = anonymous.NewJanitor(launcher, rc, auditWriter, logger, 30*time.Second)
			// Live-tune the sandbox image / resource caps from the settings
			// center; new containers pick the values up on next launch.
			settingsCenter.OnReload(func(c *config.Config) { launcher.ApplyConfig(c.Anonymous) })
		}
	}

	// Avoid the interface-nil pitfall: keep the typed launcher as a real nil
	// interface when no docker backend is configured.
	var launcherIface webssh.AnonymousLauncher
	if anonService != nil {
		launcherIface = anonService
	}

	wsGateway := webssh.NewGateway(
		webssh.GatewayOptions{
			Cfg:        cfg.WebSSH,
			Recorder:   cfg.Recorder,
			SessionDir: cfg.Storage.SessionsDir,
			DialTO:     cfg.SSHPool.DialTimeout,
			AnonOn:     anonService != nil,
		},
		logger, nodeRepo, credRepo, proxyRepo, sessionRepo,
		auditWriter, resolver, chain, hostKeyChecker.Callback(), rc,
		launcherIface,
	)
	wsGateway.SetMetrics(metricWriter)
	// Lifecycle v3 — read-only live-watch hub, shared by the terminal gateway
	// and the desktop manager so admins can monitor in-progress sessions.
	liveHub := livewatch.NewHub()
	wsGateway.SetLiveHub(liveHub)

	sftpConn := &sftp.Connector{
		Nodes: nodeRepo, Creds: credRepo, Proxies: proxyRepo,
		Resolver: resolver, Chain: chain, HostKey: hostKeyChecker.Callback(),
	}
	officeSvc := office.New(office.Config{
		Enabled:           cfg.Office.Enabled,
		DocumentServerURL: cfg.Office.DocumentServerURL,
		JWTSecret:         cfg.Office.JWTSecret,
		CallbackBaseURL:   cfg.Office.CallbackBaseURL,
	})
	// Lifecycle v3 — synthesise a browsing-window Session row for the stateless
	// SFTP / OSS REST browsers, so file/object operations link to a real session
	// (duration + bytes + timeline) instead of orphan audit rows. Reapers run in
	// the root errgroup below.
	nodeNamer := func(ctx context.Context, id uint64) string {
		if n, err := nodeRepo.FindByID(ctx, id); err == nil && n != nil {
			return n.Name
		}
		return ""
	}
	sftpSessions := sesswin.New(model.SessionSFTP, sessionRepo, auditWriter, nodeNamer, 30*time.Minute, logger)
	ossSessions := sesswin.New(model.SessionOSS, sessionRepo, auditWriter, nodeNamer, 30*time.Minute, logger)
	sftpHandler := &sftp.Handler{Conn: sftpConn, Audit: auditWriter, Logger: logger, Office: officeSvc, Sessions: sftpSessions}

	// Object-storage bastion (OSS): reaches Aliyun OSS / Tencent COS / S3
	// through the same credential pool + proxy chain as every other protocol.
	ossConn := &oss.Connector{
		Nodes: nodeRepo, Creds: credRepo, Proxies: proxyRepo,
		Chain: chain, Vault: sealer,
	}
	ossHandler := &oss.Handler{Conn: ossConn, Asset: assetResolver, Audit: auditWriter, Logger: logger, Office: officeSvc, Sessions: ossSessions}

	// Optional protocol handlers
	var guacHandler *guacamole.Handler
	if cfg.Protocols.Guacamole.Enabled {
		guacHandler = guacamole.NewHandler(wsGateway, cfg.Protocols.Guacamole, sealer)
	}
	var dbcliHandler *dbcli.Handler
	if cfg.Protocols.DBCLI.Enabled {
		dbLauncher, err := dbcli.New(cfg.Protocols.DBCLI)
		if err != nil {
			logger.Warn("dbcli docker init failed", zap.Error(err))
		} else {
			dbcliHandler = &dbcli.Handler{GW: wsGateway, Launcher: dbLauncher, Sealer: sealer, Asset: assetResolver}
		}
	}
	pfRepo := repo.NewPortForwardRepo(db)
	var pfManager *tcpfwd.Manager
	var pfHandler *tcpfwd.Handler
	var pfRelay *tcpfwd.WSRelay
	var pfEvents *tcpfwd.WSEvents
	if cfg.Protocols.TCPFwd.Enabled {
		factory := func(ctx context.Context, node *model.Node) (string, proxy.ContextDialer, func(), error) {
			hops, err := wsGateway.ResolveHops(ctx, node.ProxyChain)
			if err != nil {
				return "", nil, nil, err
			}
			dlr, rel, err := wsGateway.BuildChain(ctx, hops)
			if err != nil {
				return "", nil, nil, err
			}
			return pkgssh.AddrOf(node.Host, node.Port), dlr, rel, nil
		}
		pfManager = tcpfwd.NewManager(cfg.Protocols.TCPFwd, pfRepo, nodeRepo, rc, auditWriter, logger, factory)
		pfManager.SetLifecycle(sessionRepo, metricWriter)
		settingsCenter.OnReload(func(c *config.Config) { pfManager.ApplyConfig(c.Protocols.TCPFwd) })
		pfHandler = &tcpfwd.Handler{Manager: pfManager, Nodes: nodeRepo, Repo: pfRepo}
		pfRelay = &tcpfwd.WSRelay{GW: wsGateway, Nodes: nodeRepo}
		pfEvents = &tcpfwd.WSEvents{Manager: pfManager}
		// Rehydrate forwarders that were active when the gateway last shut
		// down. Failures are logged inside Resume; we don't block startup.
		if _, rerr := pfManager.Resume(rootCtx); rerr != nil {
			logger.Warn("tcpfwd resume failed", zap.Error(rerr))
		}
	}

	// dbSvc is shared between the REST DB handler and the AI db_* tools so both
	// use the same connection pools / proxy chains / dialect adapters.
	dbSvc := dbquery.New(wsGateway, sealer, logger, assetResolver)

	routes := &server.Routes{
		Auth: &api.AuthHandler{
			Registry: registry, Issuer: issuer,
			Users: userRepo, MFA: mfaRepo, History: historyRepo,
			Lockout: lockout, Blocklist: blocklist,
			TOTP: totpSvc, Email: emailOTP, Recovery: recoverySvc,
			Passkey: passkeySvc, OIDC: oidcManager, OIDCRepo: oidcRepo,
			Anomaly: anomalyDetector, Mailer: mailer,
			Writer:   auditWriter,
			AnonEna:  anonService != nil,
			AnonSpec: cfg.Anonymous,
		},
		Node:          &api.NodeHandler{Repo: nodeRepo, Creds: credRepo, Proxies: proxyRepo, Tags: tagRepo, Resolver: resolver, AccessItems: accessItemRepo, Access: assetResolver},
		Proxy:         &api.ProxyHandler{Repo: proxyRepo, Templates: chainTemplateRepo, Groups: proxyGroupRepo, Builder: chain},
		ChainTemplate: &api.ChainTemplateHandler{Repo: chainTemplateRepo, Proxies: proxyRepo},
		ProxyGroup:    &api.ProxyGroupHandler{Groups: proxyGroupRepo, Proxies: proxyRepo},
		ProxyHealth:   &api.HealthHandler{Reg: healthReg, Prober: proxyProber},
		ProxyMetrics:  &api.MetricsHandler{Reg: metricsReg},
		Cred:          &api.CredentialHandler{Repo: credRepo, Sealer: credentialVault, Resolver: resolver, Nodes: nodeRepo},
		Dashboard:     &api.DashboardHandler{DB: db, RBAC: rbacResolver, Asset: assetResolver},
		Session:       &api.SessionHandler{Repo: sessionRepo, Audit: auditRepo, Writer: auditWriter, Terminators: []api.SessionTerminator{wsGateway}},
		Audit:         &api.AuditHandler{Repo: auditRepo, Nodes: nodeRepo},
		SFTP:          sftpHandler,
		OSS:           ossHandler,
		WS:            wsGateway,
		Guacamole:     guacHandler,
		DBCLI:         dbcliHandler,
		DB:            api.NewDBHandler(dbSvc, nil, auditWriter),
		TCPFwd:        pfHandler,
		TCPRelay:      pfRelay,
		TCPEvents:     pfEvents,
		Issuer:        issuer,
		Blocklist:     blocklist,
		Resolver:      rbacResolver,
		User: &api.UserHandler{
			Repo: userRepo, Roles: roleRepo, Depts: deptRepo, Lockout: lockout,
			Blocklist: blocklist, Resolver: rbacResolver,
			Sessions: sessionRepo, History: historyRepo, Grants: grantRepo,
		},
		Role:       &api.RoleHandler{Repo: roleRepo, Resolver: rbacResolver},
		Dept:       &api.DepartmentHandler{Repo: deptRepo, Resolver: assetResolver},
		Group:      &api.GroupHandler{Repo: groupRepo, Resolver: assetResolver},
		AssetGroup: &api.AssetGroupHandler{Repo: assetGroupRepo, Resolver: assetResolver},
		Tag:        &api.TagHandler{Repo: tagRepo, Groups: tagGroupRepo, Resolver: assetResolver},
		TagGroup:   &api.TagGroupHandler{Repo: tagGroupRepo},
		Grant:      &api.GrantHandler{Repo: grantRepo, Resolver: assetResolver},
		AccessTree: &api.AccessTreeHandler{
			Folders: accessFolderRepo, Items: accessItemRepo, Templates: accessTemplateRepo,
			Nodes: nodeRepo, Resolver: assetResolver,
		},
		Me: &api.MeHandler{
			Users: userRepo, MFA: mfaRepo, WebAuthn: passkeySvc, TOTP: totpSvc,
			Email: emailOTP, Recovery: recoverySvc,
			Favorites: favoriteRepo, Recent: recentRepo,
			History: historyRepo, Nodes: nodeRepo, Tags: tagRepo, Resolver: assetResolver,
		},
		// Phase 14 switched OIDC client storage to the per-owner
		// envelope adapter (oidcVault) so its secrets get rewrapped on
		// rotation alongside credentials. Pre-Phase-14 code path used
		// the credential `sealer` here; that fallback is gone now.
		OIDCClient: &api.OIDCClientHandler{Repo: oidcRepo, Sealer: oidcVault, Manager: oidcManager},

		// Phase 11 — terminal personalization.
		Snippet:         &api.SnippetHandler{Repo: snippetRepo},
		CommandHistory:  &api.CommandHistoryHandler{Repo: historyRepoTerm, Profile: terminalProfileRepo},
		TerminalProfile: &api.TerminalProfileHandler{Repo: terminalProfileRepo},

		// Phase 14 — KMS provider setup wizard. Admin-only endpoints
		// under /api/v1/setup/kms/*.
		KMS: &api.KMSHandler{
			Providers: repo.NewKMSProviderRepo(db),
			Envelopes: repo.NewSecretEnvelopeRepo(db),
			Audits:    repo.NewSecretAuditRepo(db),
			Service:   secretsBoot.Service,
			Unsealer:  secretsBoot.Unsealer,
		},

		// System settings center — super-admin runtime configuration.
		Settings: &api.SettingsHandler{Center: settingsCenter, Prober: settingsProber, Writer: auditWriter},
		// Anti-leak watermark — readable by every authenticated user; reads the
		// live settings snapshot so super-admin changes apply on the next poll.
		Watermark: &api.WatermarkHandler{Users: userRepo, Center: settingsCenter},
		// (Phase 12 cherry-pick brought a duplicate OIDCClient line back —
		// dropped; the canonical wiring with Sealer: oidcVault sits earlier
		// in this struct literal.)

		// Phase 12 — SSH power.
		SSHKey:    &api.SSHKeysHandler{Repo: sshKeyRepo, Sealer: sealer},
		KnownHost: &api.KnownHostsHandler{Repo: knownHostRepo},
		BulkRun: &api.BulkRunHandler{
			Repo: bulkRunRepo, Nodes: nodeRepo, Creds: credRepo,
			Proxies: proxyRepo, Chain: chain, Resolver: resolver,
			HostKey: hostKeyChecker.Callback(),
		},
	}

	// Phase 15 — Approval Service. Always-on (no config gate) because the
	// rest of the platform's high-risk endpoints will start gating on the
	// resulting grants in subsequent phases. The bootstrap also seeds the
	// built-in templates so a fresh install has a working set without an
	// admin touching the UI.
	approvalRepo := repo.NewApprovalRepo(db)

	// Phase 16 — wire the KMS-backed ledger signer. Each Sign call
	// resolves the *currently primary* KMS provider so an admin can
	// rotate via /api/v1/setup/kms/:id/promote without restarting; new
	// events get signed by the new key, existing events keep their
	// historical signature.
	kmsProviderRepo := repo.NewKMSProviderRepo(db)
	signerLookup := func(ctx context.Context) (kms.Signer, uint64, error) {
		if secretsBoot == nil || secretsBoot.Service == nil {
			return nil, 0, nil
		}
		primary := secretsBoot.Service.PrimaryProvider()
		if primary == nil {
			return nil, 0, nil
		}
		// Type assert; providers that don't expose Sign (every cloud
		// provider in Phase 16a) cause us to fall back to hash-chain-
		// only — explicitly preferred over failing every approval
		// transition closed.
		signer, ok := primary.(kms.Signer)
		if !ok {
			return nil, 0, nil
		}
		row, err := kmsProviderRepo.Primary(ctx)
		if err != nil {
			return signer, 0, err
		}
		var rowID uint64
		if row != nil {
			rowID = row.ID
		}
		return signer, rowID, nil
	}

	// Phase 16c — optional WORM/S3 Object Lock archive. Disabled by
	// default; admins opt in by setting `approval.archive.enabled: true`
	// in the YAML. HeadBucket runs at construction so a bad bucket name
	// fails the boot loudly instead of silently dropping events.
	var approvalArchiver approval.LedgerArchiver
	if cfg.Approval.Archive.Enabled {
		ac := cfg.Approval.Archive
		arch, archErr := approval.NewS3LedgerArchiver(rootCtx, approval.S3ArchiveConfig{
			EndpointURL:     ac.EndpointURL,
			Region:          ac.Region,
			Bucket:          ac.Bucket,
			Prefix:          ac.Prefix,
			AccessKeyID:     ac.AccessKeyID,
			SecretAccessKey: ac.SecretAccessKey,
			RetentionMode:   ac.RetentionMode,
			RetentionDays:   ac.RetentionDays,
			FlushInterval:   ac.FlushInterval,
			BatchSize:       ac.BatchSize,
		})
		if archErr != nil {
			return fmt.Errorf("approval archive bootstrap: %w", archErr)
		}
		approvalArchiver = arch
		logger.Info("approval ledger archive enabled",
			zap.String("bucket", ac.Bucket),
			zap.String("retention_mode", ac.RetentionMode),
			zap.Int("retention_days", ac.RetentionDays))
	}

	approvalBoot, err := approval.Bootstrap(rootCtx, approval.BootstrapDeps{
		DB:           db,
		Repo:         approvalRepo,
		Logger:       logger,
		UserRepo:     userRepo,
		RoleRepo:     roleRepo,
		NodeRepo:     nodeRepo,
		CredRepo:     credRepo,
		SignerLookup: signerLookup,
		Archiver:     approvalArchiver,
	})
	if err != nil {
		return fmt.Errorf("approval bootstrap: %w", err)
	}
	routes.Approval = api.NewApprovalHandler(approvalBoot.Service, approvalRepo)

	// Phase 16 — wire the per-resource enforcement gate into every
	// action-bearing subsystem. The gate is opt-in per resource via the
	// RequiresApproval flags on model.Node / model.Credential; nothing
	// changes for existing deployments until an admin sets a flag.
	//
	// Pre-Phase-16 subsystems still build without these calls — passing
	// a nil approval Service degrades the gate to a no-op.
	approvalSvc := approvalBoot.Service
	wsGateway.SetApproval(approvalSvc)
	sftpHandler.Approval = approvalSvc
	ossHandler.Approval = approvalSvc
	if guacHandler != nil {
		guacHandler.Approval = approvalSvc
	}
	if dbcliHandler != nil {
		dbcliHandler.Approval = approvalSvc
	}
	// Phase 17 — wire approval into the visual DB browser too. Same
	// gate semantics as dbcli: writes (Exec) go through CheckEnforced;
	// reads are unconditional.
	if routes.DB != nil {
		routes.DB.Approval = approvalSvc
	}
	if pfHandler != nil {
		pfHandler.Approval = approvalSvc
	}

	// secrets.DecryptGate is the credential_use enforcement seam. We
	// only gate user-initiated decrypts (Audit.UserID != nil); the
	// rewrap job and bootstrap pass UserID == nil so the gate stays out
	// of the system-level decrypts that have no human in the loop.
	secretsBoot.Service.SetDecryptGate(func(ctx context.Context,
		ownerType model.SecretEnvelopeOwnerType, ownerID uint64,
		audit secrets.AuditContext) error {
		if ownerType != model.OwnerCredentialSecret {
			return nil
		}
		if audit.UserID == nil || *audit.UserID == 0 {
			return nil
		}
		res, err := approvalSvc.CheckEnforced(ctx, approval.EnforcementCheck{
			UserID:       *audit.UserID,
			BusinessType: model.ApprovalBizCredentialUse,
			ResourceType: "credential",
			ResourceID:   strconv.FormatUint(ownerID, 10),
			Action:       "credential_use",
		})
		if err != nil {
			return err
		}
		if !res.Allowed {
			return fmt.Errorf("%s", res.Reason)
		}
		return nil
	})

	// Plan 14 — wire the live system-insights service. Always constructed so a
	// super-admin can enable/disable + retune it live from the settings center;
	// the manager's own Enabled() gate (read from the hot-swappable config)
	// decides whether requests serve data or a 503.
	insightsMgr := insights.NewManager(insights.Config{
		Enabled:      cfg.Insights.Enabled,
		CacheTTL:     cfg.Insights.CacheTTL,
		SSHTimeout:   cfg.Insights.SSHTimeout,
		ProcessLimit: cfg.Insights.ProcessLimit,
	}, insights.Deps{
		Logger: logger, Nodes: nodeRepo, Creds: credRepo, Proxies: proxyRepo,
		Chain: chain, Resolver: resolver, HostKey: hostKeyChecker.Callback(),
		Asset: assetResolver,
	})
	routes.Insights = insights.NewHandler(insightsMgr)
	settingsCenter.OnReload(func(c *config.Config) {
		insightsMgr.ApplyConfig(insights.Config{
			Enabled:      c.Insights.Enabled,
			CacheTTL:     c.Insights.CacheTTL,
			SSHTimeout:   c.Insights.SSHTimeout,
			ProcessLimit: c.Insights.ProcessLimit,
		})
	})

	// Plan 17 — wire the new desktop subsystem (FreeRDP worker abstraction
	// + browser viewer). The default backend is "freerdp"; Plan 18 added
	// the startup self-check that installs deps + builds the worker if it
	// can't find one. The bootstrap runs in a background goroutine so the
	// HTTP listener comes up immediately; session starts before bootstrap
	// completes return a clean 503.
	var desktopMgr *desktop.Manager
	if cfg.Desktop.Enabled {
		// Resolve the recording dir default relative to the sessions root so
		// freerdp .dtr tapes land next to the other session recordings.
		if cfg.Desktop.Recording.Enabled && cfg.Desktop.Recording.Dir == "" {
			cfg.Desktop.Recording.Dir = filepath.Join(cfg.Storage.SessionsDir, "desktop-recordings")
		}
		// Resolve the per-user drive base relative to the sessions root too, so
		// redirected drive folders live alongside the recordings.
		if cfg.Desktop.Drive.Enabled && cfg.Desktop.Drive.Dir == "" {
			cfg.Desktop.Drive.Dir = filepath.Join(cfg.Storage.SessionsDir, "desktop-drives")
		}
		desktopMgr = desktop.NewManager(cfg.Desktop, desktop.Deps{
			Logger:   logger,
			Nodes:    nodeRepo,
			Creds:    credRepo,
			Asset:    assetResolver,
			Sealer:   sealer,
			Audit:    auditWriter,
			Sessions: sessionRepo,
			Metrics:  metricWriter,
			LiveHub:  liveHub,
			// Route the freerdp worker through the node's proxy chain (SSH
			// bastion / SOCKS5 hops) — same ResolveHops + BuildChain path
			// guacamole and tcpfwd use — so WebRDP reaches bastion-only nodes.
			DialChain: func(ctx context.Context, node *model.Node) (proxy.ContextDialer, func(), error) {
				hops, err := wsGateway.ResolveHops(ctx, node.ProxyChain)
				if err != nil {
					return nil, nil, err
				}
				return wsGateway.BuildChain(ctx, hops)
			},
		})
		desktopMgr.SetApproval(approvalSvc)
		routes.DesktopControl = desktop.NewControlHandler(desktopMgr)
		routes.DesktopWS = desktop.NewWSHandler(desktopMgr, logger)
		if cfg.Desktop.Drive.Enabled {
			routes.DesktopDrive = desktop.NewDriveHandler(cfg.Desktop.Drive, auditWriter, logger)
		}
		// Let the sessions audit page force graphical sessions off too.
		routes.Session.Terminators = append(routes.Session.Terminators, desktopMgr)

		// Plan 29 — ironrdp backend via Devolutions Gateway. JWT signer
		// + supervisor are attached to the manager; the gateway
		// subprocess itself is spawned later in the errgroup (alongside
		// the freerdp worker bootstrap). When the gateway block is
		// disabled in YAML, manager.AttachIronRDP simply doesn't run
		// and StartSession refuses backend=ironrdp.
		if cfg.Desktop.DevolutionsGateway.Enabled {
			signer, runtime, err := buildDesktopIronRDP(cfg.Desktop.DevolutionsGateway, logger)
			if err != nil {
				return fmt.Errorf("ironrdp setup: %w", err)
			}
			sup := desktop.NewGatewaySupervisor(logger, runtime, signer)
			desktopMgr.AttachIronRDP(signer, sup)
			logger.Info("desktop ironrdp backend wired",
				zap.String("binary_path", runtime.BinaryPath),
				zap.String("config_path", runtime.ConfigPath),
				zap.String("listen_url", runtime.ListenURL),
				zap.String("advertised_url", sup.AdvertisedURL()))
		}
	}

	// Workspace v2 — firewall + docker management panels. Both run
	// commands over SSH (same plumbing as insights) and surface results
	// to the workspace's right-side dock.
	sshDeps := sshrun.Deps{
		Chain: chain, Resolver: resolver, HostKey: hostKeyChecker.Callback(), Proxies: proxyRepo,
	}
	firewallMgr := firewall.NewManager(firewall.Config{Enabled: true}, firewall.Deps{
		Logger: logger, Nodes: nodeRepo, Creds: credRepo, Asset: assetResolver,
		Audit: auditWriter, SSH: sshDeps,
	})
	routes.Firewall = api.NewFirewallHandler(firewallMgr)
	dockerMgr := dockerpkg.NewManager(dockerpkg.Config{Enabled: true}, dockerpkg.Deps{
		Logger: logger, Nodes: nodeRepo, Creds: credRepo, Asset: assetResolver,
		Audit: auditWriter, SSH: sshDeps,
	})
	routes.Docker = api.NewDockerHandler(dockerMgr)
	systemdMgr := systemd.NewManager(systemd.Config{Enabled: true}, systemd.Deps{
		Logger: logger, Nodes: nodeRepo, Creds: credRepo, Asset: assetResolver,
		Audit: auditWriter, SSH: sshDeps,
	})
	routes.Systemd = api.NewSystemdHandler(systemdMgr)
	processMgr := process.NewManager(process.Config{Enabled: true}, process.Deps{
		Logger: logger, Nodes: nodeRepo, Creds: credRepo, Asset: assetResolver,
		Audit: auditWriter, SSH: sshDeps,
	})
	routes.Process = api.NewProcessHandler(processMgr)
	perfMgr := perf.NewManager(perf.Config{Enabled: true}, perf.Deps{
		Logger: logger, Nodes: nodeRepo, Creds: credRepo, Asset: assetResolver, SSH: sshDeps,
	})
	routes.Perf = api.NewPerfHandler(perfMgr)
	logsMgr := logs.NewManager(logs.Config{Enabled: true}, logs.Deps{
		Logger: logger, Nodes: nodeRepo, Creds: credRepo, Asset: assetResolver,
		SSH: sshDeps, HostKey: sshDeps.HostKey,
	})
	routes.Logs = api.NewLogsHandler(logsMgr)
	hardwareMgr := hardware.NewManager(hardware.Config{Enabled: true}, hardware.Deps{
		Logger: logger, Nodes: nodeRepo, Creds: credRepo, Asset: assetResolver, SSH: sshDeps,
	})
	routes.Hardware = api.NewHardwareHandler(hardwareMgr)
	kernelMgr := kernel.NewManager(kernel.Config{Enabled: true}, kernel.Deps{
		Logger: logger, Nodes: nodeRepo, Creds: credRepo, Asset: assetResolver, Audit: auditWriter, SSH: sshDeps,
	})
	routes.Kernel = api.NewKernelHandler(kernelMgr)
	storageMgr := storage.NewManager(storage.Config{Enabled: true}, storage.Deps{
		Logger: logger, Nodes: nodeRepo, Creds: credRepo, Asset: assetResolver, Audit: auditWriter, SSH: sshDeps,
	})
	routes.Storage = api.NewStorageHandler(storageMgr)
	nettoolsMgr := nettools.NewManager(nettools.Config{Enabled: true}, nettools.Deps{
		Logger: logger, Nodes: nodeRepo, Creds: credRepo, Asset: assetResolver, Audit: auditWriter, SSH: sshDeps,
	})
	routes.NetTools = api.NewNetToolsHandler(nettoolsMgr)
	cronMgr := cron.NewManager(cron.Config{Enabled: true}, cron.Deps{
		Logger: logger, Nodes: nodeRepo, Creds: credRepo, Asset: assetResolver, Audit: auditWriter, SSH: sshDeps,
	})
	routes.Cron = api.NewCronHandler(cronMgr)
	pkgMgr := pkg.NewManager(pkg.Config{Enabled: true}, pkg.Deps{
		Logger: logger, Nodes: nodeRepo, Creds: credRepo, Asset: assetResolver, Audit: auditWriter, SSH: sshDeps,
	})
	routes.Pkg = api.NewPkgHandler(pkgMgr)
	sysuserMgr := sysuser.NewManager(sysuser.Config{Enabled: true}, sysuser.Deps{
		Logger: logger, Nodes: nodeRepo, Creds: credRepo, Asset: assetResolver, Audit: auditWriter, SSH: sshDeps,
	})
	routes.SysUser = api.NewSysUserHandler(sysuserMgr)
	secauditMgr := secaudit.NewManager(secaudit.Config{Enabled: true}, secaudit.Deps{
		Logger: logger, Nodes: nodeRepo, Creds: credRepo, Asset: assetResolver, Audit: auditWriter, SSH: sshDeps,
	})
	routes.SecAudit = api.NewSecAuditHandler(secauditMgr)
	wireguardMgr := wireguard.NewManager(wireguard.Config{Enabled: true}, wireguard.Deps{
		Logger: logger, Nodes: nodeRepo, Creds: credRepo, Asset: assetResolver, Audit: auditWriter, SSH: sshDeps,
	})
	routes.WireGuard = api.NewWireGuardHandler(wireguardMgr)
	filesMgr := files.NewManager(files.Config{Enabled: true}, files.Deps{
		Logger: logger, Nodes: nodeRepo, Creds: credRepo, Asset: assetResolver, Audit: auditWriter, SSH: sshDeps,
	})
	routes.Files = api.NewFilesHandler(filesMgr)
	loganalyticsMgr := loganalytics.NewManager(loganalytics.Config{Enabled: true}, loganalytics.Deps{
		Logger: logger, Nodes: nodeRepo, Creds: credRepo, Asset: assetResolver, SSH: sshDeps,
	})
	routes.LogAnalytics = api.NewLogAnalyticsHandler(loganalyticsMgr)
	backupMgr := backup.NewManager(backup.Config{Enabled: true}, backup.Deps{
		Logger: logger, Nodes: nodeRepo, Creds: credRepo, Asset: assetResolver, Audit: auditWriter, SSH: sshDeps,
	})
	routes.Backup = api.NewBackupHandler(backupMgr)
	captureMgr := capture.NewManager(capture.Config{Enabled: true}, capture.Deps{
		Logger: logger, Nodes: nodeRepo, Creds: credRepo, Asset: assetResolver, Audit: auditWriter, SSH: sshDeps,
	})
	routes.Capture = api.NewCaptureHandler(captureMgr)

	// AI assistant subsystem
	aiSet := ai.New(ai.Config{
		Enabled:               cfg.AI.Enabled,
		DefaultPermissionMode: cfg.AI.DefaultPermissionMode,
		MaxIterations:         cfg.AI.MaxIterations,
		MaxSubAgentDepth:      cfg.AI.MaxSubAgentDepth,
		ToolTimeout:           cfg.AI.ToolTimeout,
		ApprovalTimeout:       cfg.AI.ApprovalTimeout,
		SSHExecReadOnlyAllow:  cfg.AI.SSHExecReadOnlyAllow,
		SSHExecReadOnlyExtra:  cfg.AI.SSHExecReadOnlyExtra,
		ConversationTTLDays:   cfg.AI.ConversationTTLDays,
		SeedDefaultAgents:     cfg.AI.SeedDefaultAgents,
		HealthProbeEnabled:    cfg.AI.HealthProbeEnabled,
		HealthProbeInterval:   cfg.AI.HealthProbeInterval,
		HealthProbeTimeout:    cfg.AI.HealthProbeTimeout,
		HealthProbeModels:     cfg.AI.HealthProbeModels,
		HealthDegradedMS:      cfg.AI.HealthDegradedMS,
	}, ai.Deps{
		DB: db, Sealer: aiVault, Logger: logger, AuditWriter: auditWriter,
		Asset: assetResolver, RBAC: rbacResolver,
		Nodes: nodeRepo, Creds: credRepo, Proxies: proxyRepo,
		Sessions: sessionRepo, AuditRepo: auditRepo,
		LoginHist: historyRepo, Users: userRepo,
		SSHResolver: resolver, Chain: chain, HostKey: hostKeyChecker.Callback(),
		SFTPConn: sftpConn, TCPFwd: pfManager, DialTimeout: cfg.SSHPool.DialTimeout,
	})
	routes.AI = aiSet

	// Extend the AI tool catalogue with the ops/db/oss tool families by reusing
	// the already-built subsystem managers (no SSH-shell reimplementation). The
	// runner shares the same registry pointer, so these late registrations are
	// visible from the next turn. nil managers simply skip their family.
	if aiSet != nil && aiSet.Enabled {
		optools.RegisterAll(aiSet.Registry(), optools.Deps{
			Logger: logger, Audit: auditWriter, Asset: assetResolver, RBAC: rbacResolver,
			Process: processMgr, Systemd: systemdMgr, Perf: perfMgr, Logs: logsMgr,
			Docker: dockerMgr, Hardware: hardwareMgr, Kernel: kernelMgr, Storage: storageMgr,
			NetTools: nettoolsMgr, Cron: cronMgr, Pkg: pkgMgr, SysUser: sysuserMgr,
			SecAudit: secauditMgr, Firewall: firewallMgr,
			DBQuery: dbSvc, OSS: ossConn,
			NodeRunner: aiSet.NodeRunner(),
		})
	}

	engine := server.NewEngine(cfg.Server, logger)
	routes.Mount(engine)

	g, gctx := errgroup.WithContext(rootCtx)
	g.Go(func() error { return auditWriter.Run(gctx) })
	g.Go(func() error { return metricWriter.Run(gctx) })
	g.Go(func() error { return sftpSessions.Run(gctx) })
	g.Go(func() error { return ossSessions.Run(gctx) })
	g.Go(func() error { return pool.Run(gctx) })
	if cfg.Health.Enabled {
		g.Go(func() error { return proxyProber.Run(gctx) })
	}
	if anonJanitor != nil {
		g.Go(func() error { return anonJanitor.Run(gctx) })
	}
	if pfManager != nil {
		g.Go(func() error { return pfManager.Run(gctx) })
	}
	if mailer != nil {
		g.Go(func() error { return mailer.Run(gctx) })
	}
	if aiSet != nil && aiSet.Enabled {
		g.Go(func() error { return aiSet.Janitor(gctx) })
		if cfg.AI.HealthProbeEnabled {
			if hp := aiSet.HealthProber(); hp != nil {
				g.Go(func() error { return hp.Run(gctx) })
			}
		}
	}
	g.Go(func() error { return server.Serve(gctx, cfg.Server.Addr, engine, cfg.Server, logger) })
	// Phase 15 — approval reconciler: expires overdue grants, escalates
	// timed-out tasks, flips past-window requests to expired. Best-effort
	// single-goroutine sweep; multiple gateway processes converge via
	// optimistic locking inside the repo.
	if approvalBoot != nil && approvalBoot.Reconciler != nil {
		g.Go(func() error { return approvalBoot.Reconciler.Run(gctx) })
	}
	// Plan 18 — async desktop worker bootstrap. Returns nil on failure so
	// the gateway keeps running; per-session error surfaces via 503 and
	// state surfaces via GET /api/v1/desktop/stats. The "scheduled" log
	// here is a sanity check — if it appears but EnsureWorker's own
	// "ensuring desktop worker availability" doesn't, the goroutine
	// never ran (errgroup canceled early).
	if desktopMgr != nil {
		logger.Info("desktop bootstrap scheduled in background goroutine",
			zap.Bool("auto_install", cfg.Desktop.AutoInstall),
			zap.String("default_backend", cfg.Desktop.DefaultBackend))
		g.Go(func() error { return desktopMgr.EnsureWorker(gctx) })
		if cfg.Desktop.DevolutionsGateway.Enabled {
			g.Go(func() error {
				if err := desktopMgr.EnsureGateway(gctx); err != nil {
					// Surface the error in /desktop/stats but don't
					// fail the errgroup — operators can fix the gateway
					// without restarting the whole jumpserver.
					logger.Warn("devolutions gateway ensure failed",
						zap.Error(err))
				}
				return nil
			})
		}
	}

	logger.Info("jumpserver started", zap.String("addr", cfg.Server.Addr))
	printBootstrapBanner(bootstrap, cfg.Server.Addr)
	if err := g.Wait(); err != nil && err != context.Canceled {
		return err
	}
	return nil
}

// bootstrapResult is non-nil only when this run actually created the admin
// user. The caller uses it to print a one-time banner with the credentials.
type bootstrapResult struct {
	Username  string
	Password  string // plaintext, only set when generated by us
	Generated bool   // true iff we picked a random password
}

func bootstrapAdmin(ctx context.Context, users *repo.UserRepo, cfg config.AuthConfig) (*bootstrapResult, error) {
	if cfg.BootstrapAdmin == "" {
		return nil, nil
	}
	existing, err := users.FindByUsername(ctx, cfg.BootstrapAdmin)
	if err != nil {
		return nil, err
	}
	if existing != nil {
		// Already provisioned on a previous boot. Nothing to print.
		return nil, nil
	}

	// First-ever boot. If the operator left the bootstrap password blank or
	// kept it at the documented placeholder "admin", we generate a strong one
	// and surface it through the startup banner. Anything else is honoured
	// verbatim — the operator clearly chose their own value.
	password := cfg.BootstrapPassword
	generated := password == "" || password == "admin" || len(password) < 12
	if generated {
		password, err = generateBootstrapPassword()
		if err != nil {
			return nil, err
		}
	}
	hashed, err := auth.HashPassword(password)
	if err != nil {
		return nil, err
	}
	u := &model.User{
		Username:     cfg.BootstrapAdmin,
		PasswordHash: hashed,
		DisplayName:  "Bootstrap Admin",
		IsAdmin:      true,
	}
	if err := users.Create(ctx, u); err != nil {
		return nil, err
	}
	return &bootstrapResult{Username: cfg.BootstrapAdmin, Password: password, Generated: generated}, nil
}

// generateBootstrapPassword returns a 20-char password drawn from a vocabulary
// that avoids ambiguous characters (0/O, l/1) so the banner is easy to copy.
func generateBootstrapPassword() (string, error) {
	const alphabet = "ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnpqrstuvwxyz23456789!@#$%^&*"
	const length = 20
	buf := make([]byte, length)
	if _, err := cryptorand.Read(buf); err != nil {
		return "", err
	}
	for i := range buf {
		buf[i] = alphabet[int(buf[i])%len(alphabet)]
	}
	return string(buf), nil
}

// printBootstrapBanner writes the new admin credentials to stdout in a hard-
// to-miss box. We deliberately bypass zap so it survives JSON-formatter
// pipelines and is easy to copy out of a docker logs / journalctl tail.
func printBootstrapBanner(res *bootstrapResult, addr string) {
	if res == nil {
		return
	}
	source := "config"
	if res.Generated {
		source = "auto-generated"
	}
	bar := "═══════════════════════════════════════════════════════════════════════"
	lines := []string{
		"",
		"  " + bar,
		"  ┃  JumpServer Anonymous — 首次启动",
		"  " + bar,
		"  ┃  已自动创建管理员账号。请妥善保存以下凭据；本信息只显示这一次。",
		"  ┃",
		fmt.Sprintf("  ┃   用户名 :  %s", res.Username),
		fmt.Sprintf("  ┃   密码   :  %s    (%s)", res.Password, source),
		fmt.Sprintf("  ┃   登录地址:  http://%s/api/v1/auth/login", normaliseAddr(addr)),
		"  ┃",
	}
	if res.Generated {
		lines = append(lines,
			"  ┃  ⚠ 该密码由系统随机生成。建议登录后立即在「我」-「个人资料」中修改，",
			"  ┃    或在 config.yaml 的 auth.bootstrap_password 中填写自定义密码后重",
			"  ┃    建库以禁用随机生成。",
			"  ┃",
		)
	} else {
		lines = append(lines,
			"  ┃  密码来自 config.yaml 的 auth.bootstrap_password 字段。",
			"  ┃",
		)
	}
	lines = append(lines, "  "+bar, "")
	for _, l := range lines {
		fmt.Fprintln(os.Stdout, l)
	}
}

// normaliseAddr turns ":8080" into "127.0.0.1:8080" for the banner URL.
func normaliseAddr(addr string) string {
	if addr == "" {
		return "127.0.0.1:8080"
	}
	if addr[0] == ':' {
		return "127.0.0.1" + addr
	}
	return addr
}

// seedRBAC inserts the permission catalogue and built-in roles, then attaches
// the admin role to the bootstrap user. Safe to run repeatedly.
func seedRBAC(ctx context.Context, roles *repo.RoleRepo, users *repo.UserRepo, bootstrapAdmin string) error {
	perms := make([]model.Permission, 0, len(auth.AllPermissions))
	for _, p := range auth.AllPermissions {
		perms = append(perms, model.Permission{Code: p.Code, Category: p.Category, Description: p.Description})
	}
	if err := roles.SyncPermissions(ctx, perms); err != nil {
		return err
	}
	for name, codes := range auth.BuiltinRoles {
		existing, err := roles.FindByName(ctx, name)
		if err != nil {
			return err
		}
		var roleID uint64
		if existing == nil {
			row := &model.Role{Name: name, IsSystem: true, Description: "Built-in role: " + name}
			if err := roles.Create(ctx, row); err != nil {
				return err
			}
			roleID = row.ID
		} else {
			roleID = existing.ID
		}
		if err := roles.SetPermissions(ctx, roleID, codes); err != nil {
			return err
		}
	}
	// Make sure the bootstrap admin user has the admin role attached.
	if bootstrapAdmin != "" {
		u, err := users.FindByUsername(ctx, bootstrapAdmin)
		if err != nil || u == nil {
			return err
		}
		adminRole, err := roles.FindByName(ctx, "admin")
		if err != nil || adminRole == nil {
			return err
		}
		return roles.AssignToUser(ctx, u.ID, adminRole.ID, nil)
	}
	return nil
}

// buildDesktopIronRDP resolves config defaults, generates / loads the RSA
// keypair, runs the install script if the gateway binary is missing
// (and auto_install is on), and returns the pieces NewGatewaySupervisor
// expects. Called once from the main wire-up when the ironrdp backend
// is enabled in YAML.
//
// Path conventions:
//
//	InstallPrefix       /opt/jumpserver/devolutions-gateway          (Linux)
//	                    ~/Library/Application Support/JumpServer/... (macOS)
//	                    %LOCALAPPDATA%\Programs\JumpServer\...       (Windows)
//	BinaryPath          <InstallPrefix>/devolutions-gateway[.exe]
//	ConfigPath          <InstallPrefix>/config/gateway.json
//	IDFile              <InstallPrefix>/config/gateway-id
//	JWTPrivateKeyFile   <InstallPrefix>/config/jwt.key   (+ jwt.key.pub auto-generated)
//
// Operators can override every path in YAML — these are just sensible
// defaults so a clean install needs zero extra knobs.
func buildDesktopIronRDP(cfg config.DevolutionsGatewayConfig, logger *zap.Logger) (*desktop.JWTSigner, desktop.DevolutionsGatewayRuntime, error) {
	installPrefix := cfg.InstallPrefix
	if installPrefix == "" {
		installPrefix = defaultDevolutionsPrefix()
	}
	binaryPath := cfg.BinaryPath
	if binaryPath == "" {
		binaryPath = desktop.DefaultBinaryPath(installPrefix)
	}
	configPath := cfg.ConfigPath
	if configPath == "" {
		configPath = filepath.Join(installPrefix, "config", "gateway.json")
	}
	idFile := cfg.IDFile
	if idFile == "" {
		idFile = filepath.Join(installPrefix, "config", "gateway-id")
	}
	keyFile := cfg.JWTPrivateKeyFile
	if keyFile == "" {
		keyFile = filepath.Join(installPrefix, "config", "jwt.key")
	}

	// Install the binary on first run if the operator opted in. The
	// install script is the same one operators run manually; calling
	// it from here just removes a step.
	if cfg.AutoInstall {
		if _, err := os.Stat(binaryPath); os.IsNotExist(err) {
			if err := runInstallDevolutionsScript(installPrefix, logger); err != nil {
				return nil, desktop.DevolutionsGatewayRuntime{}, fmt.Errorf("install devolutions-gateway: %w", err)
			}
		}
	}

	signer, err := desktop.NewJWTSigner(keyFile)
	if err != nil {
		return nil, desktop.DevolutionsGatewayRuntime{}, err
	}

	rt := desktop.DevolutionsGatewayRuntime{
		Enabled:       cfg.Enabled,
		BinaryPath:    binaryPath,
		ConfigPath:    configPath,
		IDFile:        idFile,
		ListenURL:     cfg.ListenAddr,
		ExternalURL:   cfg.ExternalURL,
		AdvertisedURL: cfg.AdvertisedURL,
		HealthTimeout: cfg.HealthTimeout,
		Verbosity:     cfg.Verbosity,
		AutoStart:     cfg.AutoStart,
	}
	return signer, rt, nil
}

// defaultDevolutionsPrefix picks the install directory the install
// script defaults to for the current OS. Kept in sync with the
// scripts/install-devolutions-gateway-*.{sh,ps1} INSTALL_PREFIX values.
func defaultDevolutionsPrefix() string {
	switch runtime.GOOS {
	case "windows":
		return filepath.Join(os.Getenv("LOCALAPPDATA"), "Programs", "JumpServer", "devolutions-gateway")
	case "darwin":
		home, _ := os.UserHomeDir()
		return filepath.Join(home, "Library", "Application Support", "JumpServer", "devolutions-gateway")
	default:
		return "/opt/jumpserver/devolutions-gateway"
	}
}

// runInstallDevolutionsScript shells out to the platform-appropriate
// install script with INSTALL_PREFIX pointing at the operator-chosen
// directory. The scripts themselves are idempotent — they download
// the upstream release archive, extract the binary, chmod it.
func runInstallDevolutionsScript(installPrefix string, logger *zap.Logger) error {
	scriptsDir := "scripts"
	if exe, err := os.Executable(); err == nil {
		// When running from a binary outside the repo (e.g. /usr/local/bin/jumpserver)
		// the scripts/ dir is conventionally next to the binary or one level up.
		// Try both before falling back to the CWD-relative path.
		cands := []string{
			filepath.Join(filepath.Dir(exe), "scripts"),
			filepath.Join(filepath.Dir(exe), "..", "scripts"),
			"scripts",
		}
		for _, c := range cands {
			if _, serr := os.Stat(c); serr == nil {
				scriptsDir = c
				break
			}
		}
	}

	var cmd *exec.Cmd
	switch runtime.GOOS {
	case "windows":
		ps := filepath.Join(scriptsDir, "install-devolutions-gateway-windows.ps1")
		cmd = exec.Command("powershell", "-NoProfile", "-ExecutionPolicy", "Bypass", "-File", ps, "-InstallPrefix", installPrefix)
	case "darwin":
		sh := filepath.Join(scriptsDir, "install-devolutions-gateway-darwin.sh")
		cmd = exec.Command("bash", sh)
	default:
		sh := filepath.Join(scriptsDir, "install-devolutions-gateway-linux.sh")
		cmd = exec.Command("bash", sh)
	}
	cmd.Env = append(os.Environ(), "INSTALL_PREFIX="+installPrefix)
	cmd.Stdout = os.Stdout
	cmd.Stderr = os.Stderr
	logger.Info("running devolutions gateway install script",
		zap.String("script", cmd.Path),
		zap.Strings("args", cmd.Args),
		zap.String("install_prefix", installPrefix))
	return cmd.Run()
}
