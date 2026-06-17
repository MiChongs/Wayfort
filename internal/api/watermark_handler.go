package api

import (
	"net/http"
	"strings"

	"github.com/gin-gonic/gin"
	"github.com/michongs/wayfort/internal/auth"
	"github.com/michongs/wayfort/internal/config"
	"github.com/michongs/wayfort/internal/repo"
	"github.com/michongs/wayfort/internal/settings"
)

// WatermarkHandler serves GET /api/v1/me/watermark — the per-user anti-leak
// watermark payload every authenticated browser fetches to render the diagonal
// identity overlay across pages and full-screen sessions.
//
// Unlike the super-admin settings surface, this endpoint is readable by every
// logged-in user: it reads the live policy from the settings center snapshot
// (so a super-admin change applies on the next client poll without a restart)
// and resolves the content template against the current user. Email and phone
// are masked server-side; the real client IP is injected here. The {date},
// {time} and {datetime} tokens are intentionally left untouched so the browser
// fills them live, letting the optional clock tick without a round-trip.
type WatermarkHandler struct {
	Users  *repo.UserRepo
	Center *settings.Center
}

type watermarkStyle struct {
	Opacity  int    `json:"opacity"`
	FontSize int    `json:"fontSize"`
	Color    string `json:"color"`
	Rotation int    `json:"rotation"`
	GapX     int    `json:"gapX"`
	GapY     int    `json:"gapY"`
}

type watermarkFeatures struct {
	AntiTamper  bool `json:"antiTamper"`
	Hardened    bool `json:"hardened"`
	LiveClock   bool `json:"liveClock"`
	RefreshSec  int  `json:"refreshSec"`
	SessionVars bool `json:"sessionVars"`
}

type watermarkBlind struct {
	Enabled bool   `json:"enabled"`
	Text    string `json:"text"`
}

type watermarkResponse struct {
	Enabled  bool              `json:"enabled"`
	Scope    string            `json:"scope"`
	Text     string            `json:"text"`
	Style    watermarkStyle    `json:"style"`
	Blind    watermarkBlind    `json:"blind"`
	Features watermarkFeatures `json:"features"`
}

// Get returns the resolved watermark for the current user, or {enabled:false}
// when the feature is off so the client tears any existing overlay down.
func (h *WatermarkHandler) Get(c *gin.Context) {
	cfg := h.Center.Snapshot().Watermark
	if !cfg.Enabled {
		c.JSON(http.StatusOK, watermarkResponse{Enabled: false})
		return
	}
	claims := auth.FromContext(c.Request.Context())
	text := h.resolve(c, cfg, claims)
	blindText := strings.TrimSpace(cfg.BlindContent)
	if blindText == "" {
		blindText = firstLine(text)
	}
	c.JSON(http.StatusOK, watermarkResponse{
		Enabled: true,
		Scope:   cfg.Scope,
		Text:    text,
		Style: watermarkStyle{
			Opacity:  cfg.Opacity,
			FontSize: cfg.FontSize,
			Color:    cfg.FontColor,
			Rotation: cfg.Rotation,
			GapX:     cfg.GapX,
			GapY:     cfg.GapY,
		},
		Blind: watermarkBlind{
			Enabled: cfg.BlindEnabled,
			Text:    blindText,
		},
		Features: watermarkFeatures{
			AntiTamper:  cfg.AntiTamper,
			Hardened:    cfg.Hardened,
			LiveClock:   cfg.LiveClock,
			RefreshSec:  cfg.RefreshSec,
			SessionVars: cfg.SessionVars,
		},
	})
}

// resolve substitutes the identity + IP tokens into the template and drops any
// line that became empty (e.g. an unset email) so the overlay has no blank
// gaps. The {date}/{time}/{datetime} clock tokens AND the session-scoped
// {asset}/{host}/{session} tokens are left untouched for the browser to fill:
// the client fills session tokens only inside a live connection and clears them
// (then trims the now-empty lines) on plain pages.
func (h *WatermarkHandler) resolve(c *gin.Context, cfg config.WatermarkConfig, claims *auth.Claims) string {
	username, name, email, phone := "", "", "", ""
	if claims != nil {
		username = claims.Username
		name = claims.Username
		if claims.Anonymous {
			name = "匿名用户"
		} else if user, err := h.Users.FindByID(c.Request.Context(), claims.UserID); err == nil && user != nil {
			username = user.Username
			name = user.DisplayName
			if name == "" {
				name = user.Username
			}
			email = maskEmail(user.Email)
			phone = maskPhone(user.Phone)
		}
	}
	replaced := strings.NewReplacer(
		"{username}", username,
		"{name}", name,
		"{email}", email,
		"{phone}", phone,
		"{ip}", c.ClientIP(),
	).Replace(cfg.Content)

	lines := strings.Split(replaced, "\n")
	kept := lines[:0]
	for _, ln := range lines {
		ln = strings.TrimRight(ln, " \t")
		if strings.TrimSpace(ln) == "" {
			continue
		}
		kept = append(kept, ln)
	}
	return strings.Join(kept, "\n")
}

// firstLine returns the first non-empty line of s, trimmed — used as the
// default blind-watermark payload (the user's identity line).
func firstLine(s string) string {
	for _, ln := range strings.Split(s, "\n") {
		if t := strings.TrimSpace(ln); t != "" {
			return t
		}
	}
	return ""
}
