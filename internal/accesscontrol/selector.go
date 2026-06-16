package accesscontrol

import (
	"encoding/json"
	"net"
	"strings"
	"time"

	"github.com/michongs/jumpserver-anonymous/internal/model"
)

// selector is the parsed dimension selector stored in AccessRule.Users/Assets/
// Accounts. A blank column → {All:true} (match anything). A non-blank JSON with
// All:false and no ids matches nothing (an admin who explicitly cleared it).
type selector struct {
	All           bool     `json:"all"`
	UserIDs       []uint64 `json:"user_ids,omitempty"`
	GroupIDs      []uint64 `json:"group_ids,omitempty"`
	DeptIDs       []uint64 `json:"dept_ids,omitempty"`
	RoleIDs       []uint64 `json:"role_ids,omitempty"`
	NodeIDs       []uint64 `json:"node_ids,omitempty"`
	AssetGroupIDs []uint64 `json:"asset_group_ids,omitempty"`
	TagIDs        []uint64 `json:"tag_ids,omitempty"`
	CredentialIDs []uint64 `json:"credential_ids,omitempty"`
}

func parseSelector(s string) selector {
	s = strings.TrimSpace(s)
	if s == "" {
		return selector{All: true}
	}
	var sel selector
	if err := json.Unmarshal([]byte(s), &sel); err != nil {
		// Unparseable selector is treated as "match all" so a corrupt blob never
		// silently widens enforcement by matching nothing AND never blocks the
		// admin from seeing the rule fire — fail visible. (CRUD validates on save.)
		return selector{All: true}
	}
	return sel
}

// matchUser tests the subject dimension against a user's expanded grantee set
// (user / group / department / role ids). grantees may be nil when the rule is
// "all".
func matchUser(sel selector, grantees map[model.GranteeType][]uint64, userID uint64) bool {
	if sel.All {
		return true
	}
	if contains(sel.UserIDs, userID) {
		return true
	}
	if grantees == nil {
		return false
	}
	return intersects(sel.GroupIDs, grantees[model.GranteeGroup]) ||
		intersects(sel.DeptIDs, grantees[model.GranteeDepartment]) ||
		intersects(sel.RoleIDs, grantees[model.GranteeRole])
}

// matchAsset tests the asset dimension. nodeGroupIDs / nodeTagIDs are the groups
// and tags the node belongs to (resolved by the caller; nil is fine).
func matchAsset(sel selector, nodeID uint64, nodeGroupIDs, nodeTagIDs []uint64) bool {
	if sel.All {
		return true
	}
	if nodeID != 0 && contains(sel.NodeIDs, nodeID) {
		return true
	}
	return intersects(sel.AssetGroupIDs, nodeGroupIDs) || intersects(sel.TagIDs, nodeTagIDs)
}

// matchAccount tests the account dimension (account == credential here).
func matchAccount(sel selector, credentialID uint64) bool {
	if sel.All {
		return true
	}
	return credentialID != 0 && contains(sel.CredentialIDs, credentialID)
}

// matchIP tests a comma-separated IP rule: each entry is a single IP, a CIDR, or
// an inclusive range "a-b". Blank or "*" matches any. An unparseable client IP
// fails closed (no match) only for non-blank rules.
func matchIP(ipRule, clientIP string) bool {
	ipRule = strings.TrimSpace(ipRule)
	if ipRule == "" || ipRule == "*" {
		return true
	}
	ip := net.ParseIP(strings.TrimSpace(clientIP))
	if ip == nil {
		return false
	}
	for _, raw := range strings.Split(ipRule, ",") {
		entry := strings.TrimSpace(raw)
		if entry == "" {
			continue
		}
		if entry == "*" {
			return true
		}
		if strings.Contains(entry, "/") {
			if _, cidr, err := net.ParseCIDR(entry); err == nil && cidr.Contains(ip) {
				return true
			}
			continue
		}
		if strings.Contains(entry, "-") {
			parts := strings.SplitN(entry, "-", 2)
			lo := net.ParseIP(strings.TrimSpace(parts[0]))
			hi := net.ParseIP(strings.TrimSpace(parts[1]))
			if lo != nil && hi != nil && bytesCompareIP(ip, lo) >= 0 && bytesCompareIP(ip, hi) <= 0 {
				return true
			}
			continue
		}
		if single := net.ParseIP(entry); single != nil && single.Equal(ip) {
			return true
		}
	}
	return false
}

// timeWindow is the parsed AccessRule.TimeWindow. Weekdays use Go's
// time.Weekday (0=Sunday..6=Saturday); empty Weekdays = every day. Start/End are
// "HH:MM" local-time bounds; empty = all day.
type timeWindow struct {
	Weekdays []int  `json:"weekdays,omitempty"`
	Start    string `json:"start,omitempty"`
	End      string `json:"end,omitempty"`
}

func matchTime(tw string, now time.Time) bool {
	tw = strings.TrimSpace(tw)
	if tw == "" {
		return true
	}
	var w timeWindow
	if err := json.Unmarshal([]byte(tw), &w); err != nil {
		return true // corrupt window → don't constrain
	}
	if len(w.Weekdays) > 0 && !contains(toU64(w.Weekdays), uint64(now.Weekday())) {
		return false
	}
	cur := now.Hour()*60 + now.Minute()
	if start, ok := parseHHMM(w.Start); ok && cur < start {
		return false
	}
	if end, ok := parseHHMM(w.End); ok && cur > end {
		return false
	}
	return true
}

// --- helpers ---

func contains(s []uint64, v uint64) bool {
	for _, x := range s {
		if x == v {
			return true
		}
	}
	return false
}

func intersects(a, b []uint64) bool {
	if len(a) == 0 || len(b) == 0 {
		return false
	}
	set := make(map[uint64]struct{}, len(a))
	for _, x := range a {
		set[x] = struct{}{}
	}
	for _, y := range b {
		if _, ok := set[y]; ok {
			return true
		}
	}
	return false
}

func toU64(in []int) []uint64 {
	out := make([]uint64, 0, len(in))
	for _, v := range in {
		if v >= 0 {
			out = append(out, uint64(v))
		}
	}
	return out
}

func parseHHMM(s string) (int, bool) {
	s = strings.TrimSpace(s)
	if s == "" {
		return 0, false
	}
	parts := strings.SplitN(s, ":", 2)
	if len(parts) != 2 {
		return 0, false
	}
	h, herr := atoiClamp(parts[0], 0, 23)
	m, merr := atoiClamp(parts[1], 0, 59)
	if !herr || !merr {
		return 0, false
	}
	return h*60 + m, true
}

func atoiClamp(s string, lo, hi int) (int, bool) {
	n := 0
	s = strings.TrimSpace(s)
	if s == "" {
		return 0, false
	}
	for _, c := range s {
		if c < '0' || c > '9' {
			return 0, false
		}
		n = n*10 + int(c-'0')
	}
	if n < lo || n > hi {
		return 0, false
	}
	return n, true
}

func bytesCompareIP(a, b net.IP) int {
	a16, b16 := a.To16(), b.To16()
	if a16 == nil || b16 == nil {
		return 0
	}
	for i := 0; i < 16; i++ {
		if a16[i] != b16[i] {
			if a16[i] < b16[i] {
				return -1
			}
			return 1
		}
	}
	return 0
}
