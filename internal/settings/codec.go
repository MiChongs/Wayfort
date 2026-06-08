package settings

import (
	"encoding/json"
	"fmt"
	"reflect"
	"strings"
	"time"

	"github.com/michongs/jumpserver-anonymous/internal/config"
)

var durationType = reflect.TypeOf(time.Duration(0))

// fieldByPath walks a struct by mapstructure tags, returning the addressable
// reflect.Value of the leaf. root must be a pointer to a struct (so the leaf is
// settable). Each path segment matches a field's `mapstructure:"<seg>"` tag.
func fieldByPath(root reflect.Value, path string) (reflect.Value, error) {
	cur := root
	segs := strings.Split(path, ".")
	for i, seg := range segs {
		if cur.Kind() == reflect.Ptr {
			cur = cur.Elem()
		}
		if cur.Kind() != reflect.Struct {
			return reflect.Value{}, fmt.Errorf("settings: %q: segment %q has non-struct parent", path, seg)
		}
		field, ok := fieldByTag(cur, seg)
		if !ok {
			return reflect.Value{}, fmt.Errorf("settings: %q: no field for segment %q", path, seg)
		}
		cur = field
		if i == len(segs)-1 {
			return cur, nil
		}
	}
	return reflect.Value{}, fmt.Errorf("settings: empty path")
}

func fieldByTag(structVal reflect.Value, seg string) (reflect.Value, bool) {
	t := structVal.Type()
	for i := 0; i < t.NumField(); i++ {
		tag := t.Field(i).Tag.Get("mapstructure")
		name := tag
		if comma := strings.IndexByte(tag, ','); comma >= 0 {
			name = tag[:comma]
		}
		if name == seg {
			return structVal.Field(i), true
		}
	}
	return reflect.Value{}, false
}

// flatten returns the JSON-friendly current value of one managed key read from
// cfg. Durations come back as their string form ("1h30m") so the UI shows a
// human duration rather than a nanosecond count. Secrets are never flattened
// here — the center substitutes a "configured" marker.
func flatten(cfg *config.Config, spec Spec) (any, error) {
	rv, err := fieldByPath(reflect.ValueOf(cfg), spec.Key)
	if err != nil {
		return nil, err
	}
	switch spec.Type {
	case TypeDuration:
		if rv.Type() == durationType {
			return time.Duration(rv.Int()).String(), nil
		}
		return rv.Interface(), nil
	case TypeBool:
		return rv.Bool(), nil
	case TypeInt:
		return rv.Int(), nil
	case TypeFloat:
		return rv.Float(), nil
	case TypeString, TypeText, TypeEnum, TypeSecret, TypeColor:
		return rv.String(), nil
	case TypeStringList, TypeStringMap:
		return rv.Interface(), nil
	default:
		return rv.Interface(), nil
	}
}

// apply parses raw JSON and writes it onto the cfg field for one managed key.
// The cfg pointer must be mutable; callers pass a fresh clone they then publish.
func apply(cfg *config.Config, spec Spec, raw json.RawMessage) error {
	rv, err := fieldByPath(reflect.ValueOf(cfg), spec.Key)
	if err != nil {
		return err
	}
	if !rv.CanSet() {
		return fmt.Errorf("settings: %q not settable", spec.Key)
	}
	switch spec.Type {
	case TypeBool:
		var v bool
		if err := json.Unmarshal(raw, &v); err != nil {
			return fmt.Errorf("%s: expected boolean", spec.Key)
		}
		rv.SetBool(v)
	case TypeInt:
		var v int64
		if err := json.Unmarshal(raw, &v); err != nil {
			return fmt.Errorf("%s: expected integer", spec.Key)
		}
		rv.SetInt(v)
	case TypeFloat:
		var v float64
		if err := json.Unmarshal(raw, &v); err != nil {
			return fmt.Errorf("%s: expected number", spec.Key)
		}
		rv.SetFloat(v)
	case TypeDuration:
		var s string
		if err := json.Unmarshal(raw, &s); err != nil {
			return fmt.Errorf("%s: expected duration string", spec.Key)
		}
		d, perr := time.ParseDuration(strings.TrimSpace(s))
		if perr != nil {
			return fmt.Errorf("%s: invalid duration %q", spec.Key, s)
		}
		rv.SetInt(int64(d))
	case TypeString, TypeText, TypeEnum, TypeSecret, TypeColor:
		var s string
		if err := json.Unmarshal(raw, &s); err != nil {
			return fmt.Errorf("%s: expected string", spec.Key)
		}
		rv.SetString(s)
	case TypeStringList:
		var v []string
		if err := json.Unmarshal(raw, &v); err != nil {
			return fmt.Errorf("%s: expected string array", spec.Key)
		}
		rv.Set(reflect.ValueOf(v))
	case TypeStringMap:
		var v map[string]string
		if err := json.Unmarshal(raw, &v); err != nil {
			return fmt.Errorf("%s: expected object", spec.Key)
		}
		rv.Set(reflect.ValueOf(v))
	default:
		return fmt.Errorf("%s: unsupported type %q", spec.Key, spec.Type)
	}
	return nil
}

// cloneConfig returns a deep-enough copy of cfg so apply() can mutate a draft
// without touching the published snapshot. config.Config holds value structs
// plus a couple of slices/maps the codec replaces wholesale on apply, so a
// shallow struct copy followed by per-key Set is safe — but slices/maps shared
// with the original would alias, so we copy those defensively.
func cloneConfig(cfg *config.Config) *config.Config {
	c := *cfg
	c.AI.SSHExecReadOnlyAllow = append([]string(nil), cfg.AI.SSHExecReadOnlyAllow...)
	c.AI.SSHExecReadOnlyExtra = append([]string(nil), cfg.AI.SSHExecReadOnlyExtra...)
	c.Desktop.WebRTC.STUNURLs = append([]string(nil), cfg.Desktop.WebRTC.STUNURLs...)
	c.Anonymous.Shell = append([]string(nil), cfg.Anonymous.Shell...)
	if cfg.Protocols.DBCLI.Images != nil {
		m := make(map[string]string, len(cfg.Protocols.DBCLI.Images))
		for k, v := range cfg.Protocols.DBCLI.Images {
			m[k] = v
		}
		c.Protocols.DBCLI.Images = m
	}
	return &c
}
