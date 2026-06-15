package repo

import (
	"context"
	"strings"
	"time"

	"github.com/michongs/jumpserver-anonymous/internal/model"
	"gorm.io/gorm"
)

type AuditRepo struct{ db *gorm.DB }

func NewAuditRepo(db *gorm.DB) *AuditRepo { return &AuditRepo{db: db} }

func (r *AuditRepo) BatchInsert(ctx context.Context, logs []model.AuditLog) error {
	if len(logs) == 0 {
		return nil
	}
	return r.db.WithContext(ctx).CreateInBatches(logs, 256).Error
}

// LastEntryHash returns the most recent entry hash for a chain, for seeding the
// in-memory chain tip on startup so a restarted instance continues its chain
// rather than forking. Empty when the chain has no rows yet (genesis).
func (r *AuditRepo) LastEntryHash(ctx context.Context, chainID string) (string, error) {
	var row model.AuditLog
	err := r.db.WithContext(ctx).
		Where("chain_id = ?", chainID).
		Order("id DESC").Limit(1).
		First(&row).Error
	if err == gorm.ErrRecordNotFound {
		return "", nil
	}
	return row.EntryHash, err
}

// ChainRows returns all rows of one chain ordered by id ascending, for the
// integrity verifier. Bounded by limit (0 = no limit) to keep the verify
// endpoint from loading an unbounded result set.
func (r *AuditRepo) ChainRows(ctx context.Context, chainID string, limit int) ([]model.AuditLog, error) {
	q := r.db.WithContext(ctx).Where("chain_id = ?", chainID).Order("id ASC")
	if limit > 0 {
		q = q.Limit(limit)
	}
	var out []model.AuditLog
	err := q.Find(&out).Error
	return out, err
}

// ChainTailAndCount returns the latest entry hash and row count for a chain —
// the state a checkpoint seals.
func (r *AuditRepo) ChainTailAndCount(ctx context.Context, chainID string) (tail string, count int64, err error) {
	if err = r.db.WithContext(ctx).Model(&model.AuditLog{}).
		Where("chain_id = ?", chainID).Count(&count).Error; err != nil {
		return "", 0, err
	}
	tail, err = r.LastEntryHash(ctx, chainID)
	return tail, count, err
}

// UpsertCheckpoint writes (or replaces) the checkpoint for a (chain_id, day).
// A re-run on the same day refreshes the seal with the latest tail/count.
func (r *AuditRepo) UpsertCheckpoint(ctx context.Context, cp *model.AuditCheckpoint) error {
	var existing model.AuditCheckpoint
	err := r.db.WithContext(ctx).
		Where("chain_id = ? AND day = ?", cp.ChainID, cp.Day).
		First(&existing).Error
	if err == nil {
		cp.ID = existing.ID
		return r.db.WithContext(ctx).Save(cp).Error
	}
	if err == gorm.ErrRecordNotFound {
		return r.db.WithContext(ctx).Create(cp).Error
	}
	return err
}

// ListCheckpoints returns a chain's checkpoints, newest day first.
func (r *AuditRepo) ListCheckpoints(ctx context.Context, chainID string) ([]model.AuditCheckpoint, error) {
	var out []model.AuditCheckpoint
	err := r.db.WithContext(ctx).
		Where("chain_id = ?", chainID).
		Order("is_genesis DESC, day DESC").Find(&out).Error
	return out, err
}

// DistinctChains lists every chain id present in the audit log — for the
// integrity report's chain selector.
func (r *AuditRepo) DistinctChains(ctx context.Context) ([]string, error) {
	var out []string
	err := r.db.WithContext(ctx).Model(&model.AuditLog{}).
		Where("chain_id <> ''").
		Distinct().Pluck("chain_id", &out).Error
	return out, err
}

// CountUnchained reports how many rows carry no chain id (pre-M4 history,
// outside the protected range).
func (r *AuditRepo) CountUnchained(ctx context.Context) (int64, error) {
	var n int64
	err := r.db.WithContext(ctx).Model(&model.AuditLog{}).
		Where("chain_id = '' OR chain_id IS NULL").Count(&n).Error
	return n, err
}

// List retrieves the audit events recorded against one session, newest-first.
// Kept for the per-session timeline; the global audit center uses Query.
func (r *AuditRepo) List(ctx context.Context, sessionID string, limit int) ([]model.AuditLog, error) {
	q := r.db.WithContext(ctx).Model(&model.AuditLog{})
	if sessionID != "" {
		q = q.Where("session_id = ?", sessionID)
	}
	if limit <= 0 {
		limit = 200
	}
	var out []model.AuditLog
	err := q.Order("id DESC").Limit(limit).Find(&out).Error
	return out, err
}

// AuditFilter is the unified predicate set shared by the global list, the row
// count, and the live stream so a page and its total always agree.
type AuditFilter struct {
	Kinds        []string
	Category     string // one of model.AuditCat*; expanded to its kind set
	UserID       uint64
	Username     string // substring
	SessionID    string
	NodeID       *uint64
	NodeName     string // exact asset name → resolved to node ids via subquery
	ClientIP     string
	Q            string // substring across username / payload / client_ip
	OnlyAbnormal bool
	From         *time.Time
	To           *time.Time
	Limit        int
	Offset       int
}

// abnormalCondition returns the SQL fragment + args that select abnormal rows:
// the noteworthy kinds, plus command rows whose payload trips a danger marker.
func abnormalCondition() (string, []any) {
	parts := []string{"kind IN ?"}
	args := []any{model.AuditAbnormalKinds}
	var likes []string
	for _, m := range model.AuditDangerousCommandMarkers {
		likes = append(likes, "LOWER(payload) LIKE ?")
		args = append(args, "%"+strings.ToLower(m)+"%")
	}
	// A failed connection stage is abnormal too; mirrors model.IsAbnormal so the
	// "仅异常" SQL filter and the per-row Go check agree.
	phasePart := "(kind = ? AND payload LIKE ?)"
	phaseArgs := []any{string(model.AuditSessionPhase), "%" + model.PhaseFailedMarker + "%"}
	if len(likes) > 0 {
		parts = append(parts, "(kind = ? AND ("+strings.Join(likes, " OR ")+"))", phasePart)
		// command kind arg has to slot in before the like args; rebuild args order.
		cmdArgs := append([]any{model.AuditAbnormalKinds, string(model.AuditCommand)}, args[1:]...)
		cmdArgs = append(cmdArgs, phaseArgs...)
		return "(" + strings.Join(parts, " OR ") + ")", cmdArgs
	}
	parts = append(parts, phasePart)
	args = append(args, phaseArgs...)
	return "(" + strings.Join(parts, " OR ") + ")", args
}

// scope applies every predicate from the filter to a base query.
func (r *AuditRepo) scope(ctx context.Context, f AuditFilter) *gorm.DB {
	q := r.db.WithContext(ctx).Model(&model.AuditLog{})
	if len(f.Kinds) > 0 {
		q = q.Where("kind IN ?", f.Kinds)
	}
	if f.Category != "" {
		if kinds := model.AuditKindsForCategory(f.Category); len(kinds) > 0 {
			q = q.Where("kind IN ?", kinds)
		}
	}
	if f.UserID != 0 {
		q = q.Where("user_id = ?", f.UserID)
	}
	if f.Username != "" {
		q = q.Where("username LIKE ?", "%"+f.Username+"%")
	}
	if f.SessionID != "" {
		q = q.Where("session_id = ?", f.SessionID)
	}
	if f.NodeID != nil {
		q = q.Where("node_id = ?", *f.NodeID)
	}
	if f.NodeName != "" {
		sub := r.db.WithContext(ctx).Model(&model.Node{}).Select("id").Where("name = ?", f.NodeName)
		q = q.Where("node_id IN (?)", sub)
	}
	if f.ClientIP != "" {
		q = q.Where("client_ip = ?", f.ClientIP)
	}
	if f.Q != "" {
		like := "%" + f.Q + "%"
		q = q.Where("username LIKE ? OR payload LIKE ? OR client_ip LIKE ?", like, like, like)
	}
	if f.From != nil {
		q = q.Where("created_at >= ?", *f.From)
	}
	if f.To != nil {
		q = q.Where("created_at <= ?", *f.To)
	}
	if f.OnlyAbnormal {
		cond, args := abnormalCondition()
		q = q.Where(cond, args...)
	}
	return q
}

// Query returns one page of events newest-first.
func (r *AuditRepo) Query(ctx context.Context, f AuditFilter) ([]model.AuditLog, error) {
	if f.Limit <= 0 || f.Limit > 500 {
		f.Limit = 100
	}
	var out []model.AuditLog
	err := r.scope(ctx, f).Order("id DESC").Limit(f.Limit).Offset(f.Offset).Find(&out).Error
	return out, err
}

// Count returns how many rows match the filter ignoring limit/offset.
func (r *AuditRepo) Count(ctx context.Context, f AuditFilter) (int64, error) {
	var n int64
	err := r.scope(ctx, f).Count(&n).Error
	return n, err
}

// After returns events with id greater than lastID (oldest-first) that still
// match the filter — the increment the live stream pushes each tick.
func (r *AuditRepo) After(ctx context.Context, lastID uint64, f AuditFilter, limit int) ([]model.AuditLog, error) {
	if limit <= 0 || limit > 500 {
		limit = 200
	}
	var out []model.AuditLog
	err := r.scope(ctx, f).Where("id > ?", lastID).Order("id ASC").Limit(limit).Find(&out).Error
	return out, err
}

// MaxID returns the highest audit id currently stored (0 when empty) so the
// live stream only emits genuinely new events.
func (r *AuditRepo) MaxID(ctx context.Context) (uint64, error) {
	var id uint64
	err := r.db.WithContext(ctx).Model(&model.AuditLog{}).
		Select("COALESCE(MAX(id), 0)").Scan(&id).Error
	return id, err
}

// ----- aggregation -----

type AuditKeyCount struct {
	Key   string `json:"key"`
	Count int64  `json:"count"`
}

type AuditDayCount struct {
	Date     string `json:"date"`
	Count    int64  `json:"count"`
	Abnormal int64  `json:"abnormal"`
}

// AuditStats backs the overview band of the audit center.
type AuditStats struct {
	Total       int64           `json:"total"`
	Today       int64           `json:"today"`
	Abnormal    int64           `json:"abnormal"`
	ActiveUsers int64           `json:"active_users"`
	Trend       []AuditDayCount `json:"trend"`
	ByCategory  []AuditKeyCount `json:"by_category"`
	TopUsers    []AuditKeyCount `json:"top_users"`
	TopNodes    []AuditKeyCount `json:"top_nodes"`
	TopIPs      []AuditKeyCount `json:"top_ips"`
	Heatmap     [][]int         `json:"heatmap"` // [7 weekdays][24 hours]
}

// Stats aggregates the overview in a handful of cheap queries. Day/heatmap
// bucketing happens in Go so the result is dialect-agnostic across
// sqlite / MySQL / Postgres (mirrors SessionRepo.Stats).
func (r *AuditRepo) Stats(ctx context.Context, trendDays int) (*AuditStats, error) {
	if trendDays <= 0 {
		trendDays = 14
	}
	out := &AuditStats{}
	base := func() *gorm.DB { return r.db.WithContext(ctx).Model(&model.AuditLog{}) }

	if err := base().Count(&out.Total).Error; err != nil {
		return nil, err
	}

	now := time.Now()
	loc := now.Location()
	localMidnight := time.Date(now.Year(), now.Month(), now.Day(), 0, 0, 0, 0, loc)
	if err := base().Where("created_at >= ?", localMidnight).Count(&out.Today).Error; err != nil {
		return nil, err
	}

	abCond, abArgs := abnormalCondition()
	if err := base().Where(abCond, abArgs...).Count(&out.Abnormal).Error; err != nil {
		return nil, err
	}

	since := localMidnight.AddDate(0, 0, -(trendDays - 1))

	// Active users over the trend window (distinct, excluding anonymous id 0).
	if err := base().Where("created_at >= ? AND user_id <> 0", since).
		Distinct("user_id").Count(&out.ActiveUsers).Error; err != nil {
		return nil, err
	}

	// By category — group by raw kind, fold into lanes in Go.
	type kc struct {
		K string
		C int64
	}
	var kinds []kc
	if err := base().Select("kind as k, count(*) as c").Group("kind").Scan(&kinds).Error; err != nil {
		return nil, err
	}
	catTotals := map[string]int64{}
	for _, row := range kinds {
		catTotals[model.AuditCategoryOf(row.K)] += row.C
	}
	for _, cat := range model.AuditCategories {
		out.ByCategory = append(out.ByCategory, AuditKeyCount{Key: cat, Count: catTotals[cat]})
	}

	// Top users / source IPs.
	var users []kc
	if err := base().Select("username as k, count(*) as c").
		Where("username <> ''").Group("username").Order("c DESC").Limit(5).Scan(&users).Error; err != nil {
		return nil, err
	}
	for _, row := range users {
		out.TopUsers = append(out.TopUsers, AuditKeyCount{Key: row.K, Count: row.C})
	}
	var ips []kc
	if err := base().Select("client_ip as k, count(*) as c").
		Where("client_ip <> ''").Group("client_ip").Order("c DESC").Limit(5).Scan(&ips).Error; err != nil {
		return nil, err
	}
	for _, row := range ips {
		out.TopIPs = append(out.TopIPs, AuditKeyCount{Key: row.K, Count: row.C})
	}

	// Top nodes — join the nodes table to surface names instead of bare ids.
	var nodes []kc
	if err := r.db.WithContext(ctx).Table("audit_logs").
		Select("nodes.name as k, count(*) as c").
		Joins("JOIN nodes ON nodes.id = audit_logs.node_id").
		Group("nodes.name").Order("c DESC").Limit(5).Scan(&nodes).Error; err != nil {
		return nil, err
	}
	for _, row := range nodes {
		out.TopNodes = append(out.TopNodes, AuditKeyCount{Key: row.K, Count: row.C})
	}

	// Trend + heatmap — pluck timestamps once, bucket in Go.
	var stamps []time.Time
	if err := base().Where("created_at >= ?", since).Pluck("created_at", &stamps).Error; err != nil {
		return nil, err
	}
	var abStamps []time.Time
	if err := base().Where("created_at >= ?", since).Where(abCond, abArgs...).
		Pluck("created_at", &abStamps).Error; err != nil {
		return nil, err
	}
	dayBuckets := map[string]int64{}
	abBuckets := map[string]int64{}
	heat := make([][]int, 7)
	for i := range heat {
		heat[i] = make([]int, 24)
	}
	for _, t := range stamps {
		lt := t.In(loc)
		dayBuckets[lt.Format("2006-01-02")]++
		heat[int(lt.Weekday())][lt.Hour()]++
	}
	for _, t := range abStamps {
		abBuckets[t.In(loc).Format("2006-01-02")]++
	}
	for i := 0; i < trendDays; i++ {
		d := since.AddDate(0, 0, i).Format("2006-01-02")
		out.Trend = append(out.Trend, AuditDayCount{Date: d, Count: dayBuckets[d], Abnormal: abBuckets[d]})
	}
	out.Heatmap = heat

	return out, nil
}
