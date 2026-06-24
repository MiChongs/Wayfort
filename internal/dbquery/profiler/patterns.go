package profiler

import "errors"

// errNoDB is returned by every Profiler method when the backing *sql.DB is nil.
// Declared once here (not per-dialect) so mysql/postgres/dameng share it.
var errNoDB = errors.New("profiler: backing *sql.DB is nil")

// commonPattern is one entry in the bundled regex catalog.
type commonPattern struct {
	Name  string
	Regex string // POSIX-extended (works on MySQL REGEXP, PostgreSQL ~)
}

// commonPatterns is the bundled regex catalog used by every Profiler.Patterns
// implementation. Engines that lack POSIX regex get fallback heuristics.
var commonPatterns = []commonPattern{
	{Name: "email", Regex: `^[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}$`},
	{Name: "phone_cn", Regex: `^1[3-9][0-9]{9}$`},
	{Name: "uuid", Regex: `^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$`},
	{Name: "ipv4", Regex: `^([0-9]{1,3}\.){3}[0-9]{1,3}$`},
	{Name: "url", Regex: `^https?://[A-Za-z0-9.-]+`},
}
