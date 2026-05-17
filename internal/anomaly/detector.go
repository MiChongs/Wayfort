// Package anomaly inspects a user's login history to flag logins that come
// from a new IP, country, or browser. Detection is async (called from the
// success path) and never blocks the login response.
package anomaly

import (
	"context"
	"strings"

	"github.com/michongs/jumpserver-anonymous/internal/model"
	"github.com/michongs/jumpserver-anonymous/internal/notify"
	"github.com/michongs/jumpserver-anonymous/internal/repo"
	"github.com/mileusna/useragent"
	"go.uber.org/zap"
)

type Detector struct {
	repo     *repo.LoginHistoryRepo
	mailer   *notify.Mailer
	logger   *zap.Logger
	notify   bool
	maxLook  int
}

func New(r *repo.LoginHistoryRepo, m *notify.Mailer, logger *zap.Logger, notifyOnAnomaly bool) *Detector {
	return &Detector{repo: r, mailer: m, logger: logger, notify: notifyOnAnomaly, maxLook: 30}
}

// Inspect returns true if this login looks anomalous. It also fires off a
// background notification email when configured.
func (d *Detector) Inspect(ctx context.Context, user *model.User, ip, ua string) bool {
	if d == nil || user == nil {
		return false
	}
	history, err := d.repo.RecentForAnomaly(ctx, user.ID, d.maxLook)
	if err != nil {
		d.logger.Warn("anomaly history fetch failed", zap.Error(err))
		return false
	}
	if len(history) == 0 {
		// First successful login — don't classify as anomaly, but seed memory.
		return false
	}
	anomalousIP := !ipKnown(history, ip)
	anomalousUA := !uaFamilyKnown(history, ua)
	if !anomalousIP && !anomalousUA {
		return false
	}
	if d.notify && user.Email != "" && d.mailer != nil {
		d.mailer.Send(notify.AnomalyLoginMessage(user.Email, user.Username, ip, ua, ""))
	}
	d.logger.Info("anomalous login detected",
		zap.String("user", user.Username),
		zap.String("ip", ip), zap.Bool("new_ip", anomalousIP),
		zap.Bool("new_ua", anomalousUA))
	return true
}

func ipKnown(hist []model.LoginHistory, ip string) bool {
	for _, h := range hist {
		if h.IP == ip {
			return true
		}
	}
	return false
}

func uaFamilyKnown(hist []model.LoginHistory, ua string) bool {
	if ua == "" {
		return true
	}
	cur := useragent.Parse(ua)
	curFamily := strings.ToLower(cur.Name + ":" + cur.OS)
	for _, h := range hist {
		if h.UserAgent == ua {
			return true
		}
		past := useragent.Parse(h.UserAgent)
		if strings.ToLower(past.Name+":"+past.OS) == curFamily {
			return true
		}
	}
	return false
}
