// Package settings turns the gateway's static YAML configuration into a live,
// database-backed system that a super-admin tunes from the browser.
//
// The design keeps config.Config as the canonical, typed shape every subsystem
// already consumes. A declarative registry (registry.go) names every key that
// is safe to manage at runtime and carries the metadata the UI needs to render
// it (label, help, control type, unit, range, whether it applies live or needs
// a restart, whether it's a secret). A reflection codec (codec.go) maps those
// dotted keys onto config.Config fields by their mapstructure tags, so adding a
// new managed knob is a one-line registry entry, not a new mapping function.
//
// The Center (center.go) loads the YAML defaults, overlays the DB overrides,
// publishes an atomic *config.Config snapshot, and notifies subscribers so the
// request-time subsystems pick up changes without a restart.
package settings

// FieldType drives both backend parsing and the frontend control choice. The
// string values are part of the schema contract consumed by the React renderer.
type FieldType string

const (
	TypeBool       FieldType = "bool"       // → Switch
	TypeInt        FieldType = "int"        // → number Input / Slider when ranged
	TypeFloat      FieldType = "float"      // → number Input
	TypeString     FieldType = "string"     // → text Input
	TypeText       FieldType = "text"       // → Textarea (multi-line)
	TypeDuration   FieldType = "duration"   // → composite number+unit control; stored "1h30m"
	TypeEnum       FieldType = "enum"       // → Select / segmented control
	TypeStringList FieldType = "stringlist" // → tag input
	TypeStringMap  FieldType = "stringmap"  // → key/value editor
	TypeSecret     FieldType = "secret"     // → password Input, write-only, masked
	TypeColor      FieldType = "color"      // → color swatch + hex Input (stored as string)
)

// EnumOption is one choice for a TypeEnum field.
type EnumOption struct {
	Value string `json:"value"`
	Label string `json:"label"`
	Help  string `json:"help,omitempty"`
}

// Spec declares one managed configuration key.
type Spec struct {
	// Key is the dotted path matching config.Config mapstructure tags, e.g.
	// "auth.lockout.threshold". It's both the DB primary key and the schema id.
	Key   string
	Group string
	Type  FieldType

	// Label / Help are operator-facing Chinese copy. Help stays factual: what
	// the knob does and the effect of changing it — no marketing tone.
	Label string
	Help  string
	// Unit is a short suffix rendered after numeric controls ("次", "MB", "条").
	// Duration fields carry their own unit picker and ignore this.
	Unit string

	// Live reports whether a change takes effect without a restart. true means
	// the owning subsystem reads the value at request time (or subscribes to the
	// center); false means the value is wired once at boot and the UI shows a
	// "重启后生效" marker.
	Live bool

	// Advanced hides the field behind a "高级" disclosure so the common surface
	// stays calm.
	Advanced bool

	// Enum is required for TypeEnum.
	Enum []EnumOption

	// Min / Max bound numeric controls (nil = unbounded). Step hints the input.
	Min  *float64
	Max  *float64
	Step *float64

	// Placeholder is the empty-state hint for text/secret inputs.
	Placeholder string

	// Integration links the key to a connectivity probe (probe id). The UI
	// groups such keys under the integration's state card and shows the live
	// 未配置→已配置→已连接→已启用→异常 status next to them.
	Integration string

	// DependsOn / DependsValue gate the field's relevance on another key. When
	// set, the UI dims/hides the field unless DependsOn currently equals
	// DependsValue (e.g. TURN credentials only matter when a TURN url is set).
	DependsOn    string
	DependsValue string
}

// Group is a left-nav section in the settings center.
type Group struct {
	ID    string
	Title string
	// Subtitle is one factual line under the section title. No filler.
	Subtitle string
	// Icon is a lucide icon name the frontend maps to a component.
	Icon string
	// Integrations lists probe ids surfaced as state cards at the top of the
	// section (in order).
	Integrations []string
	// Order sorts the nav.
	Order int
}

func f(v float64) *float64 { return &v }
