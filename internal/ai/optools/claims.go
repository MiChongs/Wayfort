package optools

import (
	"github.com/michongs/jumpserver-anonymous/internal/ai/tools"
	"github.com/michongs/jumpserver-anonymous/internal/cron"
	"github.com/michongs/jumpserver-anonymous/internal/docker"
	"github.com/michongs/jumpserver-anonymous/internal/firewall"
	"github.com/michongs/jumpserver-anonymous/internal/kernel"
	"github.com/michongs/jumpserver-anonymous/internal/nettools"
	"github.com/michongs/jumpserver-anonymous/internal/pkg"
	"github.com/michongs/jumpserver-anonymous/internal/process"
	"github.com/michongs/jumpserver-anonymous/internal/secaudit"
	"github.com/michongs/jumpserver-anonymous/internal/storage"
	"github.com/michongs/jumpserver-anonymous/internal/sysuser"
	"github.com/michongs/jumpserver-anonymous/internal/systemd"
)

// Each ops package declares its own (structurally identical) AuditClaims type,
// so the acting principal must be built per-package. ClientIP is the constant
// AI marker; UserID/Username come from the resolved tool context.

func processClaims(t tools.ToolCtx) process.AuditClaims {
	return process.AuditClaims{UserID: t.UserID, Username: t.Username, ClientIP: aiClientIP}
}

func systemdClaims(t tools.ToolCtx) systemd.AuditClaims {
	return systemd.AuditClaims{UserID: t.UserID, Username: t.Username, ClientIP: aiClientIP}
}

func dockerClaims(t tools.ToolCtx) docker.AuditClaims {
	return docker.AuditClaims{UserID: t.UserID, Username: t.Username, ClientIP: aiClientIP}
}

func firewallClaims(t tools.ToolCtx) firewall.AuditClaims {
	return firewall.AuditClaims{UserID: t.UserID, Username: t.Username, ClientIP: aiClientIP}
}

func pkgClaims(t tools.ToolCtx) pkg.AuditClaims {
	return pkg.AuditClaims{UserID: t.UserID, Username: t.Username, ClientIP: aiClientIP}
}

func cronClaims(t tools.ToolCtx) cron.AuditClaims {
	return cron.AuditClaims{UserID: t.UserID, Username: t.Username, ClientIP: aiClientIP}
}

func kernelClaims(t tools.ToolCtx) kernel.AuditClaims {
	return kernel.AuditClaims{UserID: t.UserID, Username: t.Username, ClientIP: aiClientIP}
}

func storageClaims(t tools.ToolCtx) storage.AuditClaims {
	return storage.AuditClaims{UserID: t.UserID, Username: t.Username, ClientIP: aiClientIP}
}

func sysuserClaims(t tools.ToolCtx) sysuser.AuditClaims {
	return sysuser.AuditClaims{UserID: t.UserID, Username: t.Username, ClientIP: aiClientIP}
}

func nettoolsClaims(t tools.ToolCtx) nettools.AuditClaims {
	return nettools.AuditClaims{UserID: t.UserID, Username: t.Username, ClientIP: aiClientIP}
}

func secauditClaims(t tools.ToolCtx) secaudit.AuditClaims {
	return secaudit.AuditClaims{UserID: t.UserID, Username: t.Username, ClientIP: aiClientIP}
}
