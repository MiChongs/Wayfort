// Package office builds the signed editor configuration and short-lived access
// tokens that bind an external OnlyOffice / Collabora Document Server to the
// gateway's SFTP and OSS file surfaces. It holds no IO — the protocol handlers
// (internal/sftp, internal/protocols/oss) do the reading and writing; this
// package only does the crypto + config assembly so the two surfaces stay
// consistent.
package office

import (
	"crypto/sha256"
	"encoding/hex"
	"fmt"
	"maps"
	"strings"
	"time"

	"github.com/golang-jwt/jwt/v5"
)

type Config struct {
	Enabled           bool
	DocumentServerURL string
	JWTSecret         string
	CallbackBaseURL   string
}

type Service struct{ cfg Config }

func New(cfg Config) *Service { return &Service{cfg: cfg} }

func (s *Service) Enabled() bool {
	return s != nil && s.cfg.Enabled && s.cfg.DocumentServerURL != "" && s.cfg.CallbackBaseURL != ""
}
func (s *Service) DocumentServerURL() string { return strings.TrimRight(s.cfg.DocumentServerURL, "/") }
func (s *Service) CallbackBaseURL() string   { return strings.TrimRight(s.cfg.CallbackBaseURL, "/") }

// Access is the gateway's own short-lived bearer authorizing the Document
// Server to pull a file (Write=false) or post a save callback (Write=true). It
// is NOT the user's JWT — the Document Server never sees that.
type Access struct {
	NodeID uint64 `json:"n"`
	Path   string `json:"p,omitempty"` // SFTP path
	Bucket string `json:"b,omitempty"` // OSS bucket
	Key    string `json:"k,omitempty"` // OSS key
	UserID uint64 `json:"u"`
	Write  bool   `json:"w"`
	jwt.RegisteredClaims
}

func (s *Service) secret() []byte {
	if s.cfg.JWTSecret != "" {
		return []byte(s.cfg.JWTSecret)
	}
	return []byte("wayfort-office-dev-secret-change-me")
}

func (s *Service) SignAccess(a Access, ttl time.Duration) (string, error) {
	now := time.Now()
	a.IssuedAt = jwt.NewNumericDate(now)
	a.ExpiresAt = jwt.NewNumericDate(now.Add(ttl))
	return jwt.NewWithClaims(jwt.SigningMethodHS256, a).SignedString(s.secret())
}

func (s *Service) VerifyAccess(token string) (*Access, error) {
	var a Access
	_, err := jwt.ParseWithClaims(token, &a, func(t *jwt.Token) (any, error) {
		if _, ok := t.Method.(*jwt.SigningMethodHMAC); !ok {
			return nil, fmt.Errorf("unexpected signing method")
		}
		return s.secret(), nil
	})
	if err != nil {
		return nil, err
	}
	return &a, nil
}

// VerifyDocServerJWT validates the JWT the Document Server attaches to its save
// callback (signed with the shared OnlyOffice secret). When no secret is set
// the Document Server isn't signing, so this is a no-op pass.
func (s *Service) VerifyDocServerJWT(token string) (jwt.MapClaims, error) {
	claims := jwt.MapClaims{}
	if s.cfg.JWTSecret == "" {
		return claims, nil
	}
	_, err := jwt.ParseWithClaims(token, &claims, func(t *jwt.Token) (any, error) {
		return []byte(s.cfg.JWTSecret), nil
	})
	return claims, err
}

// DocType maps a file extension onto the OnlyOffice editor family.
func DocType(ext string) string {
	switch strings.ToLower(strings.TrimPrefix(ext, ".")) {
	case "xls", "xlsx", "xlt", "xltx", "ods", "csv":
		return "cell"
	case "ppt", "pptx", "pot", "potx", "odp":
		return "slide"
	default:
		return "word"
	}
}

type EditorInput struct {
	Ext         string
	Key         string
	Title       string
	DownloadURL string
	CallbackURL string
	CanEdit     bool
	UserID      uint64
	UserName    string
}

// BuildConfig assembles the DocEditor config and, when a JWT secret is set,
// signs the whole payload as config.token (the Document Server verifies it).
func (s *Service) BuildConfig(in EditorInput) (map[string]any, error) {
	ext := strings.ToLower(strings.TrimPrefix(in.Ext, "."))
	mode := "view"
	if in.CanEdit {
		mode = "edit"
	}
	cfg := map[string]any{
		"document": map[string]any{
			"fileType": ext,
			"key":      in.Key,
			"title":    in.Title,
			"url":      in.DownloadURL,
			"permissions": map[string]any{
				"edit":     in.CanEdit,
				"download": true,
				"print":    true,
				"review":   in.CanEdit,
				"comment":  in.CanEdit,
			},
		},
		"documentType": DocType(ext),
		"editorConfig": map[string]any{
			"callbackUrl": in.CallbackURL,
			"mode":        mode,
			"lang":        "zh-CN",
			"user": map[string]any{
				"id":   fmt.Sprintf("%d", in.UserID),
				"name": in.UserName,
			},
			"customization": map[string]any{
				"autosave":       true,
				"forcesave":      true,
				"compactToolbar": false,
				"uiTheme":        "theme-classic-light",
			},
		},
	}
	if s.cfg.JWTSecret != "" {
		claims := jwt.MapClaims{}
		maps.Copy(claims, cfg)
		signed, err := jwt.NewWithClaims(jwt.SigningMethodHS256, claims).SignedString([]byte(s.cfg.JWTSecret))
		if err != nil {
			return nil, err
		}
		cfg["token"] = signed
	}
	return cfg, nil
}

// DocumentKey is a per-version cache id. The version (mtime / etag) must change
// when content changes, or the Document Server serves a stale cached copy.
func DocumentKey(ref string, version int64) string {
	sum := sha256.Sum256(fmt.Appendf(nil, "%s:%d", ref, version))
	return hex.EncodeToString(sum[:])[:20]
}
