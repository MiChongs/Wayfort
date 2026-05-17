package repo

import (
	"fmt"
	"time"

	aimodel "github.com/michongs/jumpserver-anonymous/internal/ai/model"
	"github.com/michongs/jumpserver-anonymous/internal/config"
	"github.com/michongs/jumpserver-anonymous/internal/model"

	"gorm.io/driver/mysql"
	"gorm.io/gorm"
	gormlogger "gorm.io/gorm/logger"
)

func Open(cfg config.DBConfig) (*gorm.DB, error) {
	db, err := gorm.Open(mysql.Open(cfg.DSN), &gorm.Config{
		Logger:                                   gormlogger.Default.LogMode(gormlogger.Warn),
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

func AutoMigrate(db *gorm.DB) error {
	return db.AutoMigrate(
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
