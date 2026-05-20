package approval

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"

	"github.com/michongs/jumpserver-anonymous/internal/model"
	"github.com/michongs/jumpserver-anonymous/internal/repo"
	"go.uber.org/zap"
	"gorm.io/gorm"
)

// BootstrapDeps bundles the pieces cmd/jumpserver hands the bootstrap.
type BootstrapDeps struct {
	DB     *gorm.DB
	Repo   *repo.ApprovalRepo
	Logger *zap.Logger

	// UserRepo / RoleRepo / NodeRepo are used by the default
	// ContextEnricher and ApproverLookup. Passing them through here keeps
	// approval/ free of imports against other internal/* packages so it
	// stays leaf-shaped.
	UserRepo *repo.UserRepo
	RoleRepo *repo.RoleRepo
	NodeRepo *repo.NodeRepo
	CredRepo *repo.CredentialRepo

	// SignerLookup is the optional KMS-backed signer the ledger uses
	// to produce authenticated chain entries. Nil → hash-chain-only
	// (still tamper-evident). When non-nil, the bootstrap wraps it in
	// a LedgerSigner and attaches it to the Ledger so every event
	// gets signed by the current primary KMS.
	SignerLookup KMSSignerLookup
	// Archiver is the optional WORM-style offsite archive. Nil → events
	// stay only in the PostgreSQL append-only table. When non-nil, every
	// successful AppendForRequest also batches the event for upload to
	// the archiver (S3 Object Lock today, GCS / Azure Blob Immutability
	// pluggable behind the same interface).
	Archiver LedgerArchiver
}

// BootstrapResult is what cmd/jumpserver hangs onto so it can spawn the
// reconciler and inject the handler into Routes.
type BootstrapResult struct {
	Service     *Service
	Reconciler  *Reconciler
	Ledger      *Ledger
	Policy      *PolicyEngine
	Engine      Engine
	Notifier    *FanoutNotifier
}

// Bootstrap is the single entry point cmd/jumpserver calls. It composes the
// approval subsystem from the supplied repos, seeds the built-in templates,
// and returns the orchestrating Service plus the reconciler the caller is
// expected to spawn via errgroup.
func Bootstrap(ctx context.Context, deps BootstrapDeps) (*BootstrapResult, error) {
	if deps.Repo == nil {
		return nil, errors.New("approval bootstrap: repo required")
	}
	logger := deps.Logger
	if logger == nil {
		logger = zap.NewNop()
	}

	ledger := NewLedger(deps.Repo)
	if deps.SignerLookup != nil {
		if signer := NewKMSLedgerSigner(deps.SignerLookup); signer != nil {
			ledger = ledger.WithSigner(signer)
		}
	}
	if deps.Archiver != nil {
		ledger = ledger.WithArchiver(deps.Archiver)
	}
	policy := NewPolicyEngine(deps.Repo)

	lookup := buildApproverLookup(deps.DB, deps.RoleRepo)
	enricher := buildEnricher(deps.UserRepo, deps.RoleRepo, deps.NodeRepo)
	enforcer := NewRepoEnforcer(deps.DB, deps.NodeRepo, deps.CredRepo)

	engine := NewStateMachineEngine(deps.Repo, lookup, ledger)

	fanout := NewFanout(logger)
	fanout.Register(NewWebhookNotifier())
	// Phase 16b — IM card implementations. Each posts a channel-native
	// card (Lark interactive, DingTalk actionCard, WeCom markdown,
	// Slack Block Kit, Teams MessageCard) and surfaces approve/reject
	// affordances on pending events. siem + email still ship as stubs
	// pending real wiring in a later phase.
	fanout.Register(&FeishuNotifier{})
	fanout.Register(&DingTalkNotifier{})
	fanout.Register(&WeComNotifier{})
	fanout.Register(&SlackNotifier{})
	fanout.Register(&TeamsNotifier{})
	for _, kind := range []string{"siem", "email"} {
		fanout.Register(NewStubNotifier(kind, logger))
	}

	svc, err := NewService(Options{
		Repo:     deps.Repo,
		Ledger:   ledger,
		Policy:   policy,
		Engine:   engine,
		Enricher: enricher,
		Enforcer: enforcer,
		Notifier: fanout,
		Logger:   logger,
	})
	if err != nil {
		return nil, err
	}

	if err := seedBuiltinTemplates(ctx, deps.Repo); err != nil {
		return nil, fmt.Errorf("approval bootstrap: seed templates: %w", err)
	}

	rc := NewReconciler(deps.Repo, ledger, svc, logger, ReconcilerConfig{})

	return &BootstrapResult{
		Service:    svc,
		Reconciler: rc,
		Ledger:     ledger,
		Policy:     policy,
		Engine:     engine,
		Notifier:   fanout,
	}, nil
}

// buildApproverLookup turns role names into the concrete user IDs assigned
// to that role. Falls back to an empty slice for the empty role name and
// for roles that don't exist — the workflow refuses an empty stage so a
// typoed role surfaces as a stage-spawn error rather than a silently
// skipped stage.
func buildApproverLookup(db *gorm.DB, roles *repo.RoleRepo) ApproverLookup {
	if db == nil || roles == nil {
		return func(_ context.Context, _ string) ([]uint64, error) { return nil, nil }
	}
	return func(ctx context.Context, name string) ([]uint64, error) {
		if name == "" {
			return nil, nil
		}
		role, err := roles.FindByName(ctx, name)
		if err != nil || role == nil {
			return nil, err
		}
		var rows []model.UserRole
		if err := db.WithContext(ctx).Where("role_id = ?", role.ID).Find(&rows).Error; err != nil {
			return nil, err
		}
		out := make([]uint64, 0, len(rows))
		for _, r := range rows {
			out = append(out, r.UserID)
		}
		return out, nil
	}
}

// buildEnricher returns a ContextEnricher backed by user / role / node
// repos. Missing repos degrade gracefully: an empty requester or resource
// map still lets selectors that don't reference them work.
func buildEnricher(users *repo.UserRepo, roles *repo.RoleRepo, nodes *repo.NodeRepo) ContextEnricher {
	return &repoEnricher{users: users, roles: roles, nodes: nodes}
}

type repoEnricher struct {
	users *repo.UserRepo
	roles *repo.RoleRepo
	nodes *repo.NodeRepo
}

func (e *repoEnricher) Requester(ctx context.Context, uid uint64) (map[string]any, error) {
	if e == nil || uid == 0 {
		return nil, nil
	}
	out := map[string]any{}
	if e.users != nil {
		u, err := e.users.FindByID(ctx, uid)
		if err != nil {
			return nil, err
		}
		if u != nil {
			out["id"] = u.ID
			out["username"] = u.Username
			out["display_name"] = u.DisplayName
			out["email"] = u.Email
			out["department_id"] = u.DepartmentID
			out["is_admin"] = u.IsAdmin
		}
	}
	if e.roles != nil {
		perms, err := e.roles.PermissionsForUser(ctx, uid)
		if err == nil {
			out["permissions"] = perms
		}
		rs, err := e.roles.RolesForUser(ctx, uid)
		if err == nil {
			names := make([]string, 0, len(rs))
			for _, r := range rs {
				names = append(names, r.Name)
			}
			out["roles"] = names
		}
	}
	return out, nil
}

func (e *repoEnricher) Resource(ctx context.Context, rt, rid string) (map[string]any, error) {
	if e == nil || rt == "" || rid == "" {
		return nil, nil
	}
	switch rt {
	case "node":
		if e.nodes == nil {
			return nil, nil
		}
		// node id can come in as a numeric string.
		var id uint64
		if _, err := fmt.Sscan(rid, &id); err != nil || id == 0 {
			return nil, nil
		}
		n, err := e.nodes.FindByID(ctx, id)
		if err != nil || n == nil {
			return nil, err
		}
		return map[string]any{
			"id":       n.ID,
			"name":     n.Name,
			"host":     n.Host,
			"port":     n.Port,
			"protocol": string(n.Protocol),
		}, nil
	}
	return nil, nil
}

// seedBuiltinTemplates inserts one minimal template per business type so a
// fresh install can accept requests immediately. Each template is marked
// IsSystem so the admin can't accidentally delete it; admins can still
// disable a template by toggling Enabled.
//
// The shipped templates intentionally route every request through a single
// stage of "operator" role members. Operators configure richer multi-stage
// templates (compliance review, manager approval, dual approval, …) via
// the UI in subsequent PRs.
func seedBuiltinTemplates(ctx context.Context, r *repo.ApprovalRepo) error {
	for _, t := range builtinTemplates() {
		existing, err := r.FindTemplateByName(ctx, t.Name)
		if err != nil {
			return err
		}
		if existing != nil {
			// Keep system templates in sync with the in-binary definition
			// so a code-shipping schema change rolls out on the next boot.
			existing.Description = t.Description
			existing.BusinessType = t.BusinessType
			existing.Priority = t.Priority
			existing.Selector = t.Selector
			existing.Stages = t.Stages
			existing.RiskRule = t.RiskRule
			existing.AutoApprove = t.AutoApprove
			existing.MaxDurationSec = t.MaxDurationSec
			existing.DefaultTimeoutSec = t.DefaultTimeoutSec
			existing.IsSystem = true
			if err := r.UpdateTemplate(ctx, existing); err != nil {
				return err
			}
			continue
		}
		copy := t
		if err := r.CreateTemplate(ctx, &copy); err != nil {
			return err
		}
	}
	return nil
}

// builtinTemplates returns one template per business type. The Selector,
// Stages, RiskRule, AutoApprove columns are JSON; we marshal a small
// schema-aware struct so the seeded values stay readable when an operator
// opens the admin UI.
func builtinTemplates() []model.ApprovalTemplate {
	jsonStages := func(stages []StageSpec) string {
		b, _ := json.Marshal(stages)
		return string(b)
	}
	jsonRisk := func(base string) string {
		b, _ := json.Marshal(riskRule{Base: base})
		return string(b)
	}
	autoApprove := func() string {
		// Empty when-clause means "never auto-approve"; the JSON null
		// would be ambiguous, so we just leave the column empty.
		return ""
	}
	stagesOperator := jsonStages([]StageSpec{
		{Mode: model.ApprovalStageAny, RoleNames: []string{"operator"}, TimeoutSec: 0},
	})

	return []model.ApprovalTemplate{
		{
			Name: "builtin.asset_access", IsSystem: true, Enabled: true, Priority: 100,
			BusinessType: model.ApprovalBizAssetAccess,
			Description:  "默认资产访问审批 — 单级 operator 任一审批",
			Stages:       stagesOperator,
			RiskRule:     jsonRisk("medium"),
			AutoApprove:  autoApprove(),
			MaxDurationSec: 4 * 3600,
		},
		{
			Name: "builtin.credential_use", IsSystem: true, Enabled: true, Priority: 100,
			BusinessType: model.ApprovalBizCredentialUse,
			Description:  "默认凭据使用审批 — 单级 operator 任一审批",
			Stages:       stagesOperator,
			RiskRule:     jsonRisk("high"),
			MaxDurationSec: 2 * 3600,
		},
		{
			Name: "builtin.command_exec", IsSystem: true, Enabled: true, Priority: 100,
			BusinessType: model.ApprovalBizCommandExec,
			Description:  "默认命令执行审批 — operator 任一",
			Stages:       stagesOperator,
			RiskRule:     jsonRisk("high"),
			MaxDurationSec: 1800,
		},
		{
			Name: "builtin.sql_exec", IsSystem: true, Enabled: true, Priority: 100,
			BusinessType: model.ApprovalBizSQLExec,
			Description:  "默认 SQL 执行审批",
			Stages:       stagesOperator,
			RiskRule:     jsonRisk("high"),
			MaxDurationSec: 1800,
		},
		{
			Name: "builtin.file_transfer", IsSystem: true, Enabled: true, Priority: 100,
			BusinessType: model.ApprovalBizFileTransfer,
			Description:  "默认文件传输审批",
			Stages:       stagesOperator,
			RiskRule:     jsonRisk("medium"),
			MaxDurationSec: 2 * 3600,
		},
		{
			Name: "builtin.session_extend", IsSystem: true, Enabled: true, Priority: 100,
			BusinessType: model.ApprovalBizSessionExtend,
			Description:  "默认会话续期审批",
			Stages:       stagesOperator,
			RiskRule:     jsonRisk("low"),
			MaxDurationSec: 2 * 3600,
		},
		{
			Name: "builtin.session_elevate", IsSystem: true, Enabled: true, Priority: 100,
			BusinessType: model.ApprovalBizSessionElevate,
			Description:  "默认会话提权审批",
			Stages:       stagesOperator,
			RiskRule:     jsonRisk("high"),
			MaxDurationSec: 1800,
		},
		{
			Name: "builtin.break_glass", IsSystem: true, Enabled: true, Priority: 50,
			BusinessType: model.ApprovalBizBreakGlass,
			Description:  "应急访问 (break-glass) — 全部 operator 必须批准, 短时窗",
			Stages: jsonStages([]StageSpec{
				{Mode: model.ApprovalStageAll, RoleNames: []string{"operator"}, TimeoutSec: 0},
			}),
			RiskRule:       jsonRisk("critical"),
			MaxDurationSec: 600,
		},
		{
			Name: "builtin.vendor_access", IsSystem: true, Enabled: true, Priority: 100,
			BusinessType: model.ApprovalBizVendorAccess,
			Description:  "第三方厂商访问审批",
			Stages:       stagesOperator,
			RiskRule:     jsonRisk("high"),
			MaxDurationSec: 4 * 3600,
		},
		{
			Name: "builtin.audit_view", IsSystem: true, Enabled: true, Priority: 100,
			BusinessType: model.ApprovalBizAuditView,
			Description:  "敏感审计查阅审批",
			Stages: jsonStages([]StageSpec{
				{Mode: model.ApprovalStageAny, RoleNames: []string{"auditor"}, TimeoutSec: 0},
			}),
			RiskRule:       jsonRisk("medium"),
			MaxDurationSec: 8 * 3600,
		},
	}
}
