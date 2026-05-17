package repo

import (
	"fmt"
	"log"
	"os"
	"time"

	aimodel "github.com/michongs/jumpserver-anonymous/internal/ai/model"
	"github.com/michongs/jumpserver-anonymous/internal/config"
	"github.com/michongs/jumpserver-anonymous/internal/model"

	"gorm.io/driver/mysql"
	"gorm.io/gorm"
	gormlogger "gorm.io/gorm/logger"
)

// Open dials MySQL with a runtime logger that:
//   - emits SLOW SQL warnings only when a query exceeds 1s (DDL during boot
//     and one-off ALTERs commonly cross 200ms even on healthy databases, so
//     the default threshold is too chatty),
//   - drops record-not-found noise (bootstrap and FindByX both use it as a
//     normal control-flow signal),
//   - keeps actual errors and genuine slow queries visible.
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
	db, err := gorm.Open(mysql.Open(cfg.DSN), &gorm.Config{
		Logger:                                   runtimeLogger,
		PrepareStmt:                              true,
		DisableForeignKeyConstraintWhenMigrating: true,
	})
	if err != nil {
		return nil, fmt.Errorf("open mysql: %w", err)
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
// 200–500 ms even on healthy MySQL) don't spam the SLOW SQL banner.
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
		&model.Node{},
		&model.Session{},
		&model.AuditLog{},
		&model.PortForward{},

		// User / org / RBAC
		&model.Department{},
		&model.UserGroup{},
		&model.UserGroupMember{},
		&model.Role{},
		&model.Permission{},
		&model.RolePermission{},
		&model.UserRole{},

		// Asset organisation and authorisation
		&model.AssetGroup{},
		&model.AssetGroupNode{},
		&model.AssetTag{},
		&model.NodeTag{},
		&model.AssetGrant{},
		&model.NodeFavorite{},
		&model.NodeRecent{},

		// MFA / Passkey / auth audit
		&model.UserMFA{},
		&model.UserRecoveryCode{},
		&model.WebauthnCredential{},
		&model.LoginHistory{},
		&model.OIDCClient{},

		// AI assistant
		&aimodel.AIProvider{},
		&aimodel.AIAgent{},
		&aimodel.AIConversation{},
		&aimodel.AIMessage{},
		&aimodel.AIToolInvocation{},
	)
}
