package repo

import (
	"fmt"
	"log"
	"os"
	"time"

	aimodel "github.com/michongs/wayfort/internal/ai/model"
	"github.com/michongs/wayfort/internal/config"
	"github.com/michongs/wayfort/internal/model"

	"gorm.io/driver/postgres"
	"gorm.io/gorm"
	gormlogger "gorm.io/gorm/logger"
)

// Open dials PostgreSQL with a runtime logger that:
//   - emits SLOW SQL warnings only when a query exceeds 1s (DDL during boot
//     and one-off ALTERs commonly cross 200ms even on a healthy database, so
//     the default threshold is too chatty),
//   - drops record-not-found noise (bootstrap and FindByX both use it as a
//     normal control-flow signal),
//   - keeps actual errors and genuine slow queries visible.
//
// Phase 14 — switched from MySQL to PostgreSQL because the credential pool
// now relies on bytea columns + KMS-managed envelope encryption (Vault /
// OpenBao Transit, or AWS / Azure / GCP KMS). PostgreSQL's bytea handling
// and richer type system make the GORM auto-migration sturdier; MySQL
// `varbinary(N)` ceilings interact poorly with rewrapped DEK blobs of
// varying length.
func Open(cfg config.DBConfig) (*gorm.DB, error) {
	runtimeLogger := gormlogger.New(
		log.New(os.Stdout, "\n", log.LstdFlags),
		gormlogger.Config{
			SlowThreshold:             time.Second,
			LogLevel:                  gormlogger.Warn,
			IgnoreRecordNotFoundError: true,
			Colorful:                  false,
		},
	)
	db, err := gorm.Open(postgres.Open(cfg.DSN), &gorm.Config{
		Logger:                                   runtimeLogger,
		PrepareStmt:                              true,
		DisableForeignKeyConstraintWhenMigrating: true,
	})
	if err != nil {
		return nil, fmt.Errorf("open postgres: %w", err)
	}
	sqlDB, err := db.DB()
	if err != nil {
		return nil, err
	}
	sqlDB.SetMaxOpenConns(cfg.MaxOpen)
	sqlDB.SetMaxIdleConns(cfg.MaxIdle)
	if cfg.ConnMaxLifetime <= 0 {
		cfg.ConnMaxLifetime = time.Hour
	}
	sqlDB.SetConnMaxLifetime(cfg.ConnMaxLifetime)
	return db, nil
}

// AutoMigrate runs schema migration under a silenced logger so the inevitable
// CREATE TABLE / ALTER TABLE statements during a fresh install (each easily
// 200–500 ms even on healthy PostgreSQL) don't spam the SLOW SQL banner.
//
// Phase 14 additions:
//   - SecretEnvelope: per-secret AEAD blob + wrapped DEK + KMS pointer
//   - KMSProvider:    DB-stored KMS endpoint / auth config
//   - SecretAudit:    per-decrypt audit trail
func AutoMigrate(db *gorm.DB) error {
	silent := gormlogger.New(
		log.New(os.Stdout, "\n", log.LstdFlags),
		gormlogger.Config{
			SlowThreshold:             10 * time.Second,
			LogLevel:                  gormlogger.Error,
			IgnoreRecordNotFoundError: true,
			Colorful:                  false,
		},
	)
	scoped := db.Session(&gorm.Session{Logger: silent})
	return scoped.AutoMigrate(
		&model.User{},
		&model.Credential{},
		&model.Proxy{},
		&model.ProxyChainTemplate{},
		&model.ProxyGroupMember{},
		// Network domains — single source of truth for connectivity. Migrated
		// before Node so the domain_id FK column has its target table; the
		// default domain + node backfill run via DomainRepo.EnsureDefault.
		&model.Domain{},
		// Reverse-connect Gateway Agents + one-time enrollment tokens (M2).
		&model.GatewayAgent{},
		&model.AgentEnrollToken{},
		// Internal PKI — embedded CA + issued-cert ledger (M3).
		&model.PKICA{},
		&model.PKICertificate{},
		&model.Node{},
		&model.Session{},
		&model.SessionPhase{},        // lifecycle v3 — per-stage timeline
		&model.SessionMetricSample{}, // lifecycle v3 — connection-quality samples
		&model.AuditLog{},
		&model.AuditCheckpoint{}, // M4 — signed tamper-evidence checkpoints
		&model.PortForward{},

		// User / org / RBAC
		&model.Department{},
		&model.UserDepartment{},
		&model.UserTag{},
		&model.UserGroup{},
		&model.UserGroupMember{},
		&model.Role{},
		&model.Permission{},
		&model.RolePermission{},
		&model.UserRole{},

		// Asset organisation and authorisation
		&model.AssetGroup{},
		&model.AssetGroupNode{},
		&model.AssetTagGroup{},
		&model.AssetTag{},
		&model.NodeTag{},
		&model.AssetGrant{},
		&model.NodeFavorite{},
		&model.NodeRecent{},

		// Per-object authorisation trees (授权目录) — each grantee owns a folder
		// tree of assets with inline permissions; resolved into the same access
		// set as AssetGrant, members inherit their group / department tree.
		&model.AccessFolder{},
		&model.AccessItem{},
		&model.AccessTemplate{},

		// MFA / Passkey / auth audit
		&model.UserMFA{},
		&model.UserRecoveryCode{},
		&model.WebauthnCredential{},
		&model.LoginHistory{},
		&model.Notification{}, // in-app notification center (security events + alerts)
		&model.OIDCClient{},

		// AI assistant
		&aimodel.AIProvider{},
		&aimodel.AIAgent{},
		&aimodel.AIConversation{},
		&aimodel.AIMessage{},
		&aimodel.AIToolInvocation{},
		&aimodel.AITask{},

		// AI knowledge base (RAG) + long-term memory. The pgvector `embedding`
		// columns are added separately by EnsureVectorBackend (raw DDL) so the
		// absence of the extension never breaks AutoMigrate.
		&aimodel.KnowledgeBase{},
		&aimodel.KnowledgeDocument{},
		&aimodel.KnowledgeChunk{},
		&aimodel.AgentMemory{},

		// Phase 11 — terminal snippets / history / profile
		&model.Snippet{},
		&model.CommandHistory{},
		&model.TerminalProfile{},

		// Phase 14 — credential pool envelope encryption
		&model.KMSProvider{},
		&model.SecretEnvelope{},
		&model.SecretAudit{},
		&model.KMSSealMaterial{},

		// Phase 15 — Approval Service.
		// Six tables: requests (the unit of work), tasks (per-approver
		// slots), events (append-only hash-chained ledger), templates
		// (policy DSL), grants (time-bound permission slips), and
		// subscriptions (IM/Webhook/SIEM fan-out targets).
		&model.ApprovalRequest{},
		&model.ApprovalTask{},
		&model.ApprovalEvent{},
		&model.ApprovalTemplate{},
		&model.ApprovalGrant{},
		&model.ApprovalSubscription{},

		// Break-glass (应急访问) — governance layer over the approval engine.
		// Migrated after approval since activations reference approval request /
		// grant ids (plain string columns, no FK constraint).
		&model.BreakGlassPolicy{},
		&model.BreakGlassActivation{},

		// Phase 12 — SSH power
		&model.SSHKey{},
		&model.KnownHost{},
		&model.BulkRun{},
		&model.BulkRunResult{},

		// System settings — DB-backed runtime configuration + change trail.
		&model.SystemSetting{},
		&model.SystemSettingAudit{},

		// Access control — unified rule model for the consolidated 访问控制 module.
		&model.AccessRule{},
	)
}

// EnsureVectorBackend best-effort enables the pgvector extension and adds the
// `embedding` columns used for native vector search. It is called once right
// after AutoMigrate. It returns true when pgvector is available; on any failure
// (extension not installed, insufficient privilege) it returns false and the AI
// knowledge subsystem transparently falls back to storing embeddings as JSON and
// computing cosine similarity in the application layer. HNSW indexes are NOT
// created here — the vector dimension isn't known until the first knowledge base
// is created, so the pgvector store builds the index lazily at first ingest.
func EnsureVectorBackend(db *gorm.DB) bool {
	if err := db.Exec("CREATE EXTENSION IF NOT EXISTS vector").Error; err != nil {
		return false
	}
	// Unspecified-dimension `vector` columns are allowed; a per-dimension index
	// is added later. ADD COLUMN IF NOT EXISTS keeps this idempotent across boots.
	if err := db.Exec("ALTER TABLE ai_knowledge_chunks ADD COLUMN IF NOT EXISTS embedding vector").Error; err != nil {
		return false
	}
	if err := db.Exec("ALTER TABLE ai_agent_memories ADD COLUMN IF NOT EXISTS embedding vector").Error; err != nil {
		return false
	}
	return true
}
