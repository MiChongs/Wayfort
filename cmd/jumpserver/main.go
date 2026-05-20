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
	"syscall"
	"time"

	"github.com/michongs/jumpserver-anonymous/internal/ai"
	"github.com/michongs/jumpserver-anonymous/internal/anomaly"
	"github.com/michongs/jumpserver-anonymous/internal/anonymous"
	"github.com/michongs/jumpserver-anonymous/internal/api"
	"github.com/michongs/jumpserver-anonymous/internal/approval"
	"github.com/michongs/jumpserver-anonymous/internal/asset"
	"github.com/michongs/jumpserver-anonymous/internal/audit"
	"github.com/michongs/jumpserver-anonymous/internal/auth"
	"github.com/michongs/jumpserver-anonymous/internal/cache"
	"github.com/michongs/jumpserver-anonymous/internal/config"
	"github.com/michongs/jumpserver-anonymous/internal/dialer"
	"github.com/michongs/jumpserver-anonymous/internal/mfa"
	"github.com/michongs/jumpserver-anonymous/internal/model"
	"github.com/michongs/jumpserver-anonymous/internal/notify"
	"github.com/michongs/jumpserver-anonymous/internal/passkey"
	"github.com/michongs/jumpserver-anonymous/internal/protocols/dbcli"
	"github.com/michongs/jumpserver-anonymous/internal/protocols/guacamole"
	"github.com/michongs/jumpserver-anonymous/internal/protocols/tcpfwd"
	"github.com/michongs/jumpserver-anonymous/internal/repo"
	"github.com/michongs/jumpserver-anonymous/internal/secrets"
	"github.com/michongs/jumpserver-anonymous/internal/server"
	pkgssh "github.com/michongs/jumpserver-anonymous/internal/ssh"
	"github.com/michongs/jumpserver-anonymous/internal/desktop"
	dockerpkg "github.com/michongs/jumpserver-anonymous/internal/docker"
	"github.com/michongs/jumpserver-anonymous/internal/firewall"
	"github.com/michongs/jumpserver-anonymous/internal/insights"
	"github.com/michongs/jumpserver-anonymous/internal/sftp"
	"github.com/michongs/jumpserver-anonymous/internal/sshpool"
	"github.com/michongs/jumpserver-anonymous/internal/sshrun"
	"github.com/michongs/jumpserver-anonymous/internal/webssh"
	pkgcrypto "github.com/michongs/jumpserver-anonymous/pkg/crypto"
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
	grantRepo := repo.NewGrantRepo(db)
	favoriteRepo := repo.NewFavoriteRepo(db)
	recentRepo := repo.NewRecentRepo(db)

	bootstrap, err := bootstrapAdmin(rootCtx, userRepo, cfg.Auth)
	if err != nil {
		return fmt.Errorf("bootstrap admin: %w", err)
	}
	if err := seedRBAC(rootCtx, roleRepo, userRepo, cfg.Auth.BootstrapAdmin); err != nil {
		return fmt.Errorf("seed rbac: %w", err)
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
	assetResolver := asset.NewResolver(grantRepo, groupRepo, roleRepo, userRepo, assetGroupRepo, tagRepo, nodeRepo, rc.Client())

	resolver := pkgssh.NewResolver(sealer)
	hostKeyChecker, err := pkgssh.NewHostKeyChecker("", false)
	if err != nil {
		return fmt.Errorf("host key checker: %w", err)
	}

	credProvider := &pkgssh.PoolCredentialProvider{Creds: credRepo, Resolver: resolver}
	pool := sshpool.New(cfg.SSHPool, credProvider, hostKeyChecker.Callback())
	chain := &dialer.ChainBuilder{
		Bastion: pool,
		Creds:   &pkgssh.SOCKS5CredentialResolver{Creds: credRepo, Resolver: resolver},
	}

	auditWriter := audit.NewWriter(cfg.Audit, auditRepo, logger)

	var anonService *anonymous.Service
	var anonJanitor *anonymous.Janitor
	if cfg.Anonymous.Enabled {
		launcher, err := anonymous.NewDockerLauncher(cfg.Anonymous)
		if err != nil {
			logger.Warn("docker init failed; anonymous disabled", zap.Error(err))
		} else {
			anonService = anonymous.NewService(launcher, rc, logger)
			anonJanitor = anonymous.NewJanitor(launcher, rc, logger, 30*time.Second)
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

	sftpConn := &sftp.Connector{
		Nodes: nodeRepo, Creds: credRepo, Proxies: proxyRepo,
		Resolver: resolver, Chain: chain, HostKey: hostKeyChecker.Callback(),
	}
	sftpHandler := &sftp.Handler{Conn: sftpConn, Audit: auditWriter, Logger: logger}

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
			dbcliHandler = &dbcli.Handler{GW: wsGateway, Launcher: dbLauncher, Sealer: sealer}
		}
	}
	pfRepo := repo.NewPortForwardRepo(db)
	var pfManager *tcpfwd.Manager
	var pfHandler *tcpfwd.Handler
	var pfRelay *tcpfwd.WSRelay
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
		pfManager = tcpfwd.NewManager(cfg.Protocols.TCPFwd, pfRepo, rc, auditWriter, logger, factory)
		pfHandler = &tcpfwd.Handler{Manager: pfManager, Nodes: nodeRepo, Repo: pfRepo}
		pfRelay = &tcpfwd.WSRelay{GW: wsGateway, Nodes: nodeRepo}
	}

	routes := &server.Routes{
		Auth: &api.AuthHandler{
			Registry: registry, Issuer: issuer,
			Users: userRepo, MFA: mfaRepo, History: historyRepo,
			Lockout: lockout, Blocklist: blocklist,
			TOTP: totpSvc, Email: emailOTP, Recovery: recoverySvc,
			Passkey: passkeySvc, OIDC: oidcManager, OIDCRepo: oidcRepo,
			Anomaly: anomalyDetector, Mailer: mailer,
			AnonEna: anonService != nil,
		},
		Node:       &api.NodeHandler{Repo: nodeRepo},
		Proxy:      &api.ProxyHandler{Repo: proxyRepo},
		Cred:       &api.CredentialHandler{Repo: credRepo, Sealer: credentialVault},
		Session:    &api.SessionHandler{Repo: sessionRepo},
		SFTP:       sftpHandler,
		WS:         wsGateway,
		Guacamole:  guacHandler,
		DBCLI:      dbcliHandler,
		TCPFwd:     pfHandler,
		TCPRelay:   pfRelay,
		Issuer:     issuer,
		Blocklist:  blocklist,
		Resolver:   rbacResolver,
		User: &api.UserHandler{
			Repo: userRepo, Roles: roleRepo, Lockout: lockout,
			Blocklist: blocklist, Resolver: rbacResolver,
		},
		Role: &api.RoleHandler{Repo: roleRepo, Resolver: rbacResolver},
		Dept: &api.DepartmentHandler{Repo: deptRepo},
		Group: &api.GroupHandler{Repo: groupRepo},
		AssetGroup: &api.AssetGroupHandler{Repo: assetGroupRepo, Resolver: assetResolver},
		Tag:   &api.TagHandler{Repo: tagRepo, Resolver: assetResolver},
		Grant: &api.GrantHandler{Repo: grantRepo, Resolver: assetResolver},
		Me: &api.MeHandler{
			Users: userRepo, MFA: mfaRepo, WebAuthn: passkeySvc, TOTP: totpSvc,
			Email: emailOTP, Recovery: recoverySvc,
			Favorites: favoriteRepo, Recent: recentRepo,
			History: historyRepo, Nodes: nodeRepo, Resolver: assetResolver,
		},
		OIDCClient: &api.OIDCClientHandler{Repo: oidcRepo, Sealer: oidcVault, Manager: oidcManager},

		KMS: &api.KMSHandler{
			Providers: repo.NewKMSProviderRepo(db),
			Envelopes: repo.NewSecretEnvelopeRepo(db),
			Audits:    repo.NewSecretAuditRepo(db),
			Service:   secretsBoot.Service,
			Unsealer:  secretsBoot.Unsealer,
		},
	}

	// Phase 15 — Approval Service. Always-on (no config gate) because the
	// rest of the platform's high-risk endpoints will start gating on the
	// resulting grants in subsequent phases. The bootstrap also seeds the
	// built-in templates so a fresh install has a working set without an
	// admin touching the UI.
	approvalRepo := repo.NewApprovalRepo(db)
	approvalBoot, err := approval.Bootstrap(rootCtx, approval.BootstrapDeps{
		DB:       db,
		Repo:     approvalRepo,
		Logger:   logger,
		UserRepo: userRepo,
		RoleRepo: roleRepo,
		NodeRepo: nodeRepo,
	})
	if err != nil {
		return fmt.Errorf("approval bootstrap: %w", err)
	}
	routes.Approval = api.NewApprovalHandler(approvalBoot.Service, approvalRepo)

	// Plan 14 — wire the live system-insights service. Disabled by default;
	// turn on with `insights.enabled: true` in config.
	if cfg.Insights.Enabled {
		insightsMgr := insights.NewManager(insights.Config{
			Enabled:      true,
			CacheTTL:     cfg.Insights.CacheTTL,
			SSHTimeout:   cfg.Insights.SSHTimeout,
			ProcessLimit: cfg.Insights.ProcessLimit,
		}, insights.Deps{
			Logger: logger, Nodes: nodeRepo, Creds: credRepo, Proxies: proxyRepo,
			Chain: chain, Resolver: resolver, HostKey: hostKeyChecker.Callback(),
			Asset: assetResolver,
		})
		routes.Insights = insights.NewHandler(insightsMgr)
	}

	// Plan 17 — wire the new desktop subsystem (FreeRDP worker abstraction
	// + browser viewer). The default backend is "freerdp"; Plan 18 added
	// the startup self-check that installs deps + builds the worker if it
	// can't find one. The bootstrap runs in a background goroutine so the
	// HTTP listener comes up immediately; session starts before bootstrap
	// completes return a clean 503.
	var desktopMgr *desktop.Manager
	if cfg.Desktop.Enabled {
		desktopMgr = desktop.NewManager(cfg.Desktop, desktop.Deps{
			Logger:   logger,
			Nodes:    nodeRepo,
			Creds:    credRepo,
			Asset:    assetResolver,
			Sealer:   sealer,
			Audit:    auditWriter,
			Sessions: sessionRepo,
		})
		routes.DesktopControl = desktop.NewControlHandler(desktopMgr)
		routes.DesktopWS = desktop.NewWSHandler(desktopMgr, logger)

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

	engine := server.NewEngine(cfg.Server, logger)
	routes.Mount(engine)

	g, gctx := errgroup.WithContext(rootCtx)
	g.Go(func() error { return auditWriter.Run(gctx) })
	g.Go(func() error { return pool.Run(gctx) })
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
//   InstallPrefix       /opt/jumpserver/devolutions-gateway          (Linux)
//                       ~/Library/Application Support/JumpServer/... (macOS)
//                       %LOCALAPPDATA%\Programs\JumpServer\...       (Windows)
//   BinaryPath          <InstallPrefix>/devolutions-gateway[.exe]
//   ConfigPath          <InstallPrefix>/config/gateway.json
//   IDFile              <InstallPrefix>/config/gateway-id
//   JWTPrivateKeyFile   <InstallPrefix>/config/jwt.key   (+ jwt.key.pub auto-generated)
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
