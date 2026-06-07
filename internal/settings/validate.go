package settings

import (
	"encoding/json"
	"fmt"
	"strings"
	"time"

	"github.com/michongs/jumpserver-anonymous/internal/config"
)

// validateValue checks one incoming change against its spec: correct JSON
// shape, numeric range, enum membership, parseable duration. Messages are
// operator-facing Chinese so they surface verbatim in the UI toast.
func validateValue(spec Spec, raw json.RawMessage) error {
	switch spec.Type {
	case TypeBool:
		var v bool
		if err := json.Unmarshal(raw, &v); err != nil {
			return fmt.Errorf("%s：应为开关值", spec.Label)
		}
	case TypeInt:
		var v float64
		if err := json.Unmarshal(raw, &v); err != nil || v != float64(int64(v)) {
			return fmt.Errorf("%s：应为整数", spec.Label)
		}
		if spec.Min != nil && v < *spec.Min {
			return fmt.Errorf("%s：不能小于 %s", spec.Label, trimNum(*spec.Min))
		}
		if spec.Max != nil && v > *spec.Max {
			return fmt.Errorf("%s：不能大于 %s", spec.Label, trimNum(*spec.Max))
		}
	case TypeFloat:
		var v float64
		if err := json.Unmarshal(raw, &v); err != nil {
			return fmt.Errorf("%s：应为数值", spec.Label)
		}
		if spec.Min != nil && v < *spec.Min {
			return fmt.Errorf("%s：不能小于 %s", spec.Label, trimNum(*spec.Min))
		}
		if spec.Max != nil && v > *spec.Max {
			return fmt.Errorf("%s：不能大于 %s", spec.Label, trimNum(*spec.Max))
		}
	case TypeDuration:
		var s string
		if err := json.Unmarshal(raw, &s); err != nil {
			return fmt.Errorf("%s：应为时长字符串", spec.Label)
		}
		if _, err := time.ParseDuration(strings.TrimSpace(s)); err != nil {
			return fmt.Errorf("%s：时长格式无效（示例 30s / 5m / 1h30m）", spec.Label)
		}
	case TypeEnum:
		var s string
		if err := json.Unmarshal(raw, &s); err != nil {
			return fmt.Errorf("%s：应为枚举值", spec.Label)
		}
		for _, e := range spec.Enum {
			if e.Value == s {
				return nil
			}
		}
		return fmt.Errorf("%s：取值不在允许范围内", spec.Label)
	case TypeString, TypeText, TypeSecret:
		var s string
		if err := json.Unmarshal(raw, &s); err != nil {
			return fmt.Errorf("%s：应为文本", spec.Label)
		}
	case TypeStringList:
		var v []string
		if err := json.Unmarshal(raw, &v); err != nil {
			return fmt.Errorf("%s：应为字符串列表", spec.Label)
		}
	case TypeStringMap:
		var v map[string]string
		if err := json.Unmarshal(raw, &v); err != nil {
			return fmt.Errorf("%s：应为键值对", spec.Label)
		}
	default:
		return fmt.Errorf("%s：不支持的类型", spec.Label)
	}
	return nil
}

// auditValue renders the current (pre-change) value of a key for the trail.
func auditValue(spec Spec, cfg *config.Config) string {
	if spec.Type == TypeSecret {
		return "•••"
	}
	v, err := flatten(cfg, spec)
	if err != nil {
		return ""
	}
	b, _ := json.Marshal(v)
	return truncate(string(b), 256)
}

// auditValueRaw renders an incoming change value for the trail.
func auditValueRaw(spec Spec, raw json.RawMessage) string {
	if spec.Type == TypeSecret {
		return "•••"
	}
	return truncate(compactJSON(raw), 256)
}

func truncate(s string, n int) string {
	r := []rune(s)
	if len(r) <= n {
		return s
	}
	return string(r[:n]) + "…"
}

func trimNum(v float64) string {
	if v == float64(int64(v)) {
		return fmt.Sprintf("%d", int64(v))
	}
	return fmt.Sprintf("%g", v)
}
