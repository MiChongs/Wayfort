package settings

import (
	"bytes"
	"context"
	"encoding/base64"
	"encoding/json"
	"fmt"
	"strings"
	"sync"
	"sync/atomic"
	"time"

	"github.com/michongs/jumpserver-anonymous/internal/config"
	"github.com/michongs/jumpserver-anonymous/internal/model"
	"github.com/michongs/jumpserver-anonymous/internal/repo"
	"go.uber.org/zap"
)

// Sealer wraps secret values at rest. Satisfied by *kms.Unsealer (the same
// bootstrap-derived key that seals KMS provider auth material), so secret
// settings get the same protection as the gateway's other high-value secrets.
type Sealer interface {
	Seal(plaintext []byte) ([]byte, error)
	Open(ciphertext []byte) ([]byte, error)
}

// Center is the live configuration authority. It overlays DB-persisted overrides
// onto the YAML/code defaults, publishes an atomic *config.Config snapshot that
// request-time subsystems read, and fans changes out to subscribers so the
// live-reloadable knobs apply without a restart.
type Center struct {
	base   *config.Config // defaults from YAML + code; never mutated
	repo   *repo.SystemSettingRepo
	sealer Sealer
	logger *zap.Logger

	snap atomic.Pointer[config.Config]

	mu   sync.Mutex
	subs []func(*config.Config)
}

// New builds the center, computes the initial effective snapshot and returns it
// ready to publish. base is the *config.Config as loaded from YAML — its managed
// keys act as the seed defaults the DB overlays.
func New(ctx context.Context, base *config.Config, r *repo.SystemSettingRepo, sealer Sealer, logger *zap.Logger) (*Center, error) {
	c := &Center{base: base, repo: r, sealer: sealer, logger: logger}
	eff, err := c.build(ctx)
	if err != nil {
		return nil, err
	}
	c.snap.Store(eff)
	return c, nil
}

// Snapshot returns the current effective config. Never nil after New. Callers
// must treat it as read-only.
func (c *Center) Snapshot() *config.Config { return c.snap.Load() }

// FieldValue returns one key's current effective value for the schema endpoint.
// For secrets it never returns the material — only whether one is configured.
func (c *Center) FieldValue(spec Spec) (value any, secretSet bool) {
	cfg := c.snap.Load()
	v, err := flatten(cfg, spec)
	if err != nil {
		return nil, false
	}
	if spec.Type == TypeSecret {
		s, _ := v.(string)
		return nil, strings.TrimSpace(s) != ""
	}
	return v, false
}

// RecentAudits returns the newest managed-setting change events.
func (c *Center) RecentAudits(ctx context.Context, limit int) ([]model.SystemSettingAudit, error) {
	return c.repo.RecentAudits(ctx, limit)
}

// OverriddenKeys returns the set of keys that currently have a DB override (vs.
// falling back to their YAML/code default). Drives the "已自定义" marker and the
// per-field reset action in the UI.
func (c *Center) OverriddenKeys(ctx context.Context) (map[string]bool, error) {
	rows, err := c.repo.All(ctx)
	if err != nil {
		return nil, err
	}
	out := make(map[string]bool, len(rows))
	for k := range rows {
		if _, ok := specByKey[k]; ok {
			out[k] = true
		}
	}
	return out, nil
}

// OnReload registers a callback fired (with the new snapshot) after every
// successful Update/Reset. Used to push live-reloadable changes into the
// request-time subsystems. The callback runs synchronously outside the center
// lock; keep it quick and non-blocking.
func (c *Center) OnReload(fn func(*config.Config)) {
	c.mu.Lock()
	c.subs = append(c.subs, fn)
	c.mu.Unlock()
}

// build clones base and applies every DB override (decrypting secrets) onto it.
func (c *Center) build(ctx context.Context) (*config.Config, error) {
	rows, err := c.repo.All(ctx)
	if err != nil {
		return nil, fmt.Errorf("load settings: %w", err)
	}
	eff := cloneConfig(c.base)
	for key, row := range rows {
		spec, ok := specByKey[key]
		if !ok {
			continue // stale key from an older build; ignore
		}
		raw, err := c.decodeStored(spec, row)
		if err != nil {
			c.logger.Warn("settings: skip unreadable override", zap.String("key", key), zap.Error(err))
			continue
		}
		if raw == nil {
			continue
		}
		if err := apply(eff, spec, raw); err != nil {
			c.logger.Warn("settings: skip invalid override", zap.String("key", key), zap.Error(err))
		}
	}
	return eff, nil
}

// decodeStored turns a persisted row into the json.RawMessage apply() expects.
// Secret rows hold base64(sealed-bytes); we open them and re-encode the
// plaintext as a JSON string. nil means "no value to apply".
func (c *Center) decodeStored(spec Spec, row model.SystemSetting) (json.RawMessage, error) {
	if spec.Type != TypeSecret {
		if strings.TrimSpace(row.Value) == "" {
			return nil, nil
		}
		return json.RawMessage(row.Value), nil
	}
	if row.Value == "" {
		return nil, nil
	}
	sealed, err := base64.StdEncoding.DecodeString(row.Value)
	if err != nil {
		return nil, fmt.Errorf("base64: %w", err)
	}
	if c.sealer == nil {
		return nil, fmt.Errorf("sealer unavailable")
	}
	plain, err := c.sealer.Open(sealed)
	if err != nil {
		return nil, fmt.Errorf("unseal: %w", err)
	}
	enc, _ := json.Marshal(string(plain))
	return enc, nil
}

// Update validates, persists, and live-applies a batch of changes. Returns the
// keys that need a restart to fully take effect (Live=false specs that changed).
func (c *Center) Update(ctx context.Context, changes map[string]json.RawMessage, actorID uint64, actorName string) (restartKeys []string, err error) {
	c.mu.Lock()
	defer c.mu.Unlock()

	cur := c.snap.Load()
	draft := cloneConfig(cur)

	var rows []model.SystemSetting
	var audits []model.SystemSettingAudit
	now := time.Now().UTC()

	for key, raw := range changes {
		spec, ok := specByKey[key]
		if !ok {
			return nil, fmt.Errorf("未知配置项：%s", key)
		}
		// Secret with empty payload = "leave unchanged".
		if spec.Type == TypeSecret && isEmptyJSONString(raw) {
			continue
		}
		if verr := validateValue(spec, raw); verr != nil {
			return nil, verr
		}
		// Apply to the draft so subsequent validations (and the snapshot) see it.
		applyRaw := raw
		var stored model.SystemSetting
		stored.Key = key
		stored.UpdatedBy = actorID
		stored.UpdatedAt = now
		if spec.Type == TypeSecret {
			var plain string
			_ = json.Unmarshal(raw, &plain)
			sealed, serr := c.seal(plain)
			if serr != nil {
				return nil, fmt.Errorf("%s：密钥加密失败：%w", spec.Label, serr)
			}
			stored.Secret = true
			stored.Value = sealed
		} else {
			stored.Value = compactJSON(raw)
		}
		if aerr := apply(draft, spec, applyRaw); aerr != nil {
			return nil, aerr
		}
		rows = append(rows, stored)
		audits = append(audits, model.SystemSettingAudit{
			Key: key, Group: spec.Group,
			OldValue: auditValue(spec, cur),
			NewValue: auditValueRaw(spec, raw),
			ActorID:  actorID, ActorName: actorName, CreatedAt: now,
		})
		if !spec.Live {
			restartKeys = append(restartKeys, key)
		}
	}

	if len(rows) == 0 {
		return nil, nil
	}
	if err := c.repo.Upsert(ctx, rows); err != nil {
		return nil, fmt.Errorf("保存失败：%w", err)
	}
	if err := c.repo.AppendAudit(ctx, audits); err != nil {
		c.logger.Warn("settings: audit append failed", zap.Error(err))
	}

	c.snap.Store(draft)
	// Fire subscribers after publishing the snapshot. They run under the center
	// lock here, which is fine: callbacks only swap their own atomic config.
	for _, fn := range c.subs {
		fn(draft)
	}
	return restartKeys, nil
}

// Reset drops the overrides for the given keys so they fall back to the YAML/code
// default, then rebuilds + republishes the snapshot.
func (c *Center) Reset(ctx context.Context, keys []string, actorID uint64, actorName string) error {
	c.mu.Lock()
	defer c.mu.Unlock()

	valid := keys[:0]
	now := time.Now().UTC()
	var audits []model.SystemSettingAudit
	cur := c.snap.Load()
	for _, k := range keys {
		spec, ok := specByKey[k]
		if !ok {
			continue
		}
		valid = append(valid, k)
		audits = append(audits, model.SystemSettingAudit{
			Key: k, Group: spec.Group, OldValue: auditValue(spec, cur), NewValue: "（默认）",
			ActorID: actorID, ActorName: actorName, CreatedAt: now,
		})
	}
	if len(valid) == 0 {
		return nil
	}
	if err := c.repo.Delete(ctx, valid); err != nil {
		return fmt.Errorf("重置失败：%w", err)
	}
	_ = c.repo.AppendAudit(ctx, audits)

	eff, err := c.build(ctx)
	if err != nil {
		return err
	}
	c.snap.Store(eff)
	for _, fn := range c.subs {
		fn(eff)
	}
	return nil
}

func (c *Center) seal(plain string) (string, error) {
	if c.sealer == nil {
		return "", fmt.Errorf("sealer unavailable")
	}
	sealed, err := c.sealer.Seal([]byte(plain))
	if err != nil {
		return "", err
	}
	return base64.StdEncoding.EncodeToString(sealed), nil
}

// --- small helpers ---

func isEmptyJSONString(raw json.RawMessage) bool {
	var s string
	if err := json.Unmarshal(raw, &s); err != nil {
		return false
	}
	return s == ""
}

func compactJSON(raw json.RawMessage) string {
	var buf bytes.Buffer
	if err := json.Compact(&buf, raw); err != nil {
		return string(raw)
	}
	return buf.String()
}
