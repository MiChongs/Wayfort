package main

import (
	"context"
	"flag"
	"fmt"
	"os"
	"os/signal"
	"syscall"
	"time"

	"github.com/michongs/jumpserver-anonymous/internal/anonymous"
	"github.com/michongs/jumpserver-anonymous/internal/api"
	"github.com/michongs/jumpserver-anonymous/internal/audit"
	"github.com/michongs/jumpserver-anonymous/internal/auth"
	"github.com/michongs/jumpserver-anonymous/internal/cache"
	"github.com/michongs/jumpserver-anonymous/internal/config"
	"github.com/michongs/jumpserver-anonymous/internal/dialer"
	"github.com/michongs/jumpserver-anonymous/internal/model"
	"github.com/michongs/jumpserver-anonymous/internal/repo"
	"github.com/michongs/jumpserver-anonymous/internal/server"
	pkgssh "github.com/michongs/jumpserver-anonymous/internal/ssh"
	"github.com/michongs/jumpserver-anonymous/internal/sftp"
	"github.com/michongs/jumpserver-anonymous/internal/sshpool"
	"github.com/michongs/jumpserver-anonymous/internal/webssh"
	pkgcrypto "github.com/michongs/jumpserver-anonymous/pkg/crypto"
	pkglog "github.com/michongs/jumpserver-anonymous/pkg/log"
	"go.uber.org/zap"
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

	sealer, err := pkgcrypto.NewSealer(cfg.Crypto.MasterKeyHex)
	if err != nil {
		return fmt.Errorf("crypto: %w", err)
	}
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

	if err := bootstrapAdmin(rootCtx, userRepo, cfg.Auth); err != nil {
		return fmt.Errorf("bootstrap admin: %w", err)
	}

	issuer := auth.NewIssuer(cfg.Auth.JWTSecret, cfg.Auth.AccessTTL, cfg.Auth.RefreshTTL)
	registry := auth.NewRegistry()
	registry.Register(auth.NewLocalProvider(userRepo))
	registry.Register(auth.NewOIDCProvider())

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

	routes := &server.Routes{
		Auth: &api.AuthHandler{
			Registry: registry, Issuer: issuer, Audit: auditWriter,
			AnonEna: anonService != nil,
		},
		Node:    &api.NodeHandler{Repo: nodeRepo},
		Proxy:   &api.ProxyHandler{Repo: proxyRepo},
		Cred:    &api.CredentialHandler{Repo: credRepo, Sealer: sealer},
		Session: &api.SessionHandler{Repo: sessionRepo},
		SFTP:    sftpHandler,
		WS:      wsGateway,
		Issuer:  issuer,
	}

	engine := server.NewEngine(cfg.Server, logger)
	routes.Mount(engine)

	g, gctx := errgroup.WithContext(rootCtx)
	g.Go(func() error { return auditWriter.Run(gctx) })
	g.Go(func() error { return pool.Run(gctx) })
	if anonJanitor != nil {
		g.Go(func() error { return anonJanitor.Run(gctx) })
	}
	g.Go(func() error { return server.Serve(gctx, cfg.Server.Addr, engine, cfg.Server, logger) })

	logger.Info("jumpserver started", zap.String("addr", cfg.Server.Addr))
	if err := g.Wait(); err != nil && err != context.Canceled {
		return err
	}
	return nil
}

func bootstrapAdmin(ctx context.Context, users *repo.UserRepo, cfg config.AuthConfig) error {
	if cfg.BootstrapAdmin == "" {
		return nil
	}
	existing, err := users.FindByUsername(ctx, cfg.BootstrapAdmin)
	if err != nil {
		return err
	}
	if existing != nil {
		return nil
	}
	hashed, err := auth.HashPassword(cfg.BootstrapPassword)
	if err != nil {
		return err
	}
	u := &model.User{
		Username:     cfg.BootstrapAdmin,
		PasswordHash: hashed,
		DisplayName:  "Bootstrap Admin",
		IsAdmin:      true,
	}
	return users.Create(ctx, u)
}
