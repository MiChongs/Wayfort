// Package ai is the top-level wiring for the AI assistant subsystem. main.go
// constructs a Set (the public facing bundle of handlers + janitor) once and
// hands it to the server router.
package ai

import (
	"context"
	"time"

	"github.com/michongs/jumpserver-anonymous/internal/ai/bridge"
	"github.com/michongs/jumpserver-anonymous/internal/ai/handler"
	"github.com/michongs/jumpserver-anonymous/internal/ai/provider"
	airepo "github.com/michongs/jumpserver-anonymous/internal/ai/repo"
	"github.com/michongs/jumpserver-anonymous/internal/ai/runner"
	"github.com/michongs/jumpserver-anonymous/internal/ai/tools"
	"github.com/michongs/jumpserver-anonymous/internal/asset"
	"github.com/michongs/jumpserver-anonymous/internal/audit"
	"github.com/michongs/jumpserver-anonymous/internal/auth"
	"github.com/michongs/jumpserver-anonymous/internal/dialer"
	"github.com/michongs/jumpserver-anonymous/internal/protocols/tcpfwd"
	"github.com/michongs/jumpserver-anonymous/internal/repo"
	pkgssh "github.com/michongs/jumpserver-anonymous/internal/ssh"
	"github.com/michongs/jumpserver-anonymous/internal/sftp"
	pkgcrypto "github.com/michongs/jumpserver-anonymous/pkg/crypto"
	"go.uber.org/zap"
	"gorm.io/gorm"
	xssh "golang.org/x/crypto/ssh"
)

// Config mirrors the YAML knobs in cfg.AI.
type Config struct {
	Enabled               bool
	DefaultPermissionMode string
	MaxIterations         int
	MaxSubAgentDepth      int
	ToolTimeout           time.Duration
	ApprovalTimeout       time.Duration
	SSHExecReadOnlyAllow  []string
	SSHExecReadOnlyExtra  []string
	ConversationTTLDays   int
	SeedDefaultAgents     bool
}

// Deps is everything ai.New needs from the host process.
type Deps struct {
	DB         *gorm.DB
	Sealer     pkgcrypto.Vault
	Logger     *zap.Logger
	AuditWriter *audit.Writer
	Asset      *asset.Resolver
	RBAC       *auth.Resolver

	Nodes     *repo.NodeRepo
	Creds     *repo.CredentialRepo
	Proxies   *repo.ProxyRepo
	Sessions  *repo.SessionRepo
	AuditRepo *repo.AuditRepo
	LoginHist *repo.LoginHistoryRepo
	Users     *repo.UserRepo

	SSHResolver *pkgssh.Resolver
	Chain       *dialer.ChainBuilder
	HostKey     xssh.HostKeyCallback
	SFTPConn    *sftp.Connector
	TCPFwd      *tcpfwd.Manager

	DialTimeout time.Duration
}

// Set is what gets handed to the server router.
type Set struct {
	Enabled      bool
	Provider     *handler.ProviderHandler
	Agent        *handler.AgentHandler
	Conversation *handler.ConversationHandler
	SSE          *handler.SSEHandler
	Invocation   *handler.InvocationHandler

	Factory      *runner.Factory
	ProviderRepo *airepo.ProviderRepo
	AgentRepo    *airepo.AgentRepo
	ConvRepo     *airepo.ConversationRepo
	Cfg          Config
}

// New builds the entire AI subsystem.
func New(cfg Config, deps Deps) *Set {
	if !cfg.Enabled {
		return &Set{Enabled: false}
	}

	providerRepo := airepo.NewProviderRepo(deps.DB)
	agentRepo := airepo.NewAgentRepo(deps.DB)
	convRepo := airepo.NewConversationRepo(deps.DB)
	msgRepo := airepo.NewMessageRepo(deps.DB)
	invRepo := airepo.NewInvocationRepo(deps.DB)

	providerReg := provider.NewRegistry(providerRepo, deps.Sealer)

	toolReg := tools.NewRegistry()

	nodeRunner := &bridge.NodeRunner{
		Nodes: deps.Nodes, Creds: deps.Creds, Proxies: deps.Proxies,
		Resolver: deps.SSHResolver, Chain: deps.Chain, HostKey: deps.HostKey,
		Asset: deps.Asset, DialTimeout: deps.DialTimeout,
	}
	sftpRunner := &bridge.SFTPRunner{Conn: deps.SFTPConn, Asset: deps.Asset}
	pfMgr := &bridge.PortForwardManager{Mgr: deps.TCPFwd, Nodes: deps.Nodes}

	// Wire the gate's auth/asset back-pointers via the shared box. We can't
	// pass the runner instance here yet (chicken-and-egg with sub-agent),
	// so the SubAgentRunner is filled below.
	runner.ToolDepsView.Asset = deps.Asset
	runner.ToolDepsView.RBAC = deps.RBAC

	tdeps := tools.Deps{
		Asset: deps.Asset, RBAC: deps.RBAC, Audit: deps.AuditWriter,
		Nodes: deps.Nodes, Creds: deps.Creds, Proxies: deps.Proxies,
		Sessions: deps.Sessions, AuditRepo: deps.AuditRepo,
		LoginHist: deps.LoginHist, Users: deps.Users,
		PortFwdMgr: pfMgr, NodeRunner: nodeRunner, SFTPRunner: sftpRunner,
		// AgentRunner is patched in below once we own the factory.
	}
	// Register every builtin tool except call_subagent — that one needs the
	// factory as a SubAgentRunner.
	tools.RegisterNodeTools(toolReg, tdeps)
	tools.RegisterSSHTools(toolReg, tdeps, cfg.SSHExecReadOnlyAllow, cfg.SSHExecReadOnlyExtra)
	tools.RegisterSFTPTools(toolReg, tdeps)
	tools.RegisterSessionTools(toolReg, tdeps)
	tools.RegisterIdentityTools(toolReg, tdeps)

	factory := runner.NewFactory(providerReg, toolReg, convRepo, msgRepo, invRepo,
		agentRepo, deps.AuditWriter, deps.Logger, runner.Config{
			MaxIterations:    cfg.MaxIterations,
			MaxSubAgentDepth: cfg.MaxSubAgentDepth,
			ToolTimeout:      cfg.ToolTimeout,
			ApprovalTimeout:  cfg.ApprovalTimeout,
		})
	tdeps.AgentRunner = factory
	tools.RegisterSubAgentTool(toolReg, tdeps)

	// Seed the built-in global agents on first start. Idempotent — existing
	// rows by the same name are left intact so operator edits stick.
	if cfg.SeedDefaultAgents {
		seedCtx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
		if n, err := SeedDefaultAgents(seedCtx, agentRepo, deps.Logger); err != nil {
			deps.Logger.Warn("seed default ai agents failed", zap.Error(err))
		} else if n > 0 {
			deps.Logger.Info("seeded default ai agents", zap.Int("count", n))
		}
		cancel()
	}

	return &Set{
		Enabled: true,
		Provider: &handler.ProviderHandler{Repo: providerRepo, Sealer: deps.Sealer, Registry: providerReg},
		Agent:    &handler.AgentHandler{Repo: agentRepo, Tools: toolReg},
		Conversation: &handler.ConversationHandler{
			Repo: convRepo, Msg: msgRepo, Inv: invRepo,
			Agents: agentRepo, Factory: factory,
		},
		SSE:        &handler.SSEHandler{Conv: convRepo, Factory: factory},
		Invocation: &handler.InvocationHandler{Conv: convRepo, Inv: invRepo, Factory: factory},
		Factory:    factory,
		ProviderRepo: providerRepo,
		AgentRepo:    agentRepo,
		ConvRepo:     convRepo,
		Cfg:          cfg,
	}
}

// Janitor periodically removes conversations older than ConversationTTLDays.
func (s *Set) Janitor(ctx context.Context) error {
	if !s.Enabled || s.Cfg.ConversationTTLDays <= 0 {
		<-ctx.Done()
		return ctx.Err()
	}
	t := time.NewTicker(6 * time.Hour)
	defer t.Stop()
	for {
		select {
		case <-ctx.Done():
			return ctx.Err()
		case <-t.C:
			cutoff := time.Now().AddDate(0, 0, -s.Cfg.ConversationTTLDays)
			_, _ = s.ConvRepo.PurgeOlderThan(ctx, cutoff)
		}
	}
}
