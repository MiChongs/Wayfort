package repo

import (
	"context"
	"testing"
	"time"

	"github.com/michongs/jumpserver-anonymous/internal/model"
	"gorm.io/driver/sqlite"
	"gorm.io/gorm"
)

func newAuditTestDB(t *testing.T) *gorm.DB {
	t.Helper()
	db, err := gorm.Open(sqlite.Open(":memory:"), &gorm.Config{})
	if err != nil {
		t.Fatalf("open sqlite: %v", err)
	}
	if err := db.AutoMigrate(&model.Node{}, &model.AuditLog{}); err != nil {
		t.Fatalf("migrate: %v", err)
	}
	return db
}

func uptr(v uint64) *uint64 { return &v }

func seedAudit(t *testing.T, db *gorm.DB) *AuditRepo {
	t.Helper()
	if err := db.Create(&model.Node{ID: 1, Name: "web-01", Protocol: "ssh", Host: "10.0.0.1"}).Error; err != nil {
		t.Fatalf("seed node: %v", err)
	}
	now := time.Now()
	rows := []model.AuditLog{
		{Kind: model.AuditCommand, UserID: 1, Username: "alice", NodeID: uptr(1), ClientIP: "10.0.0.5", Payload: "ls -la", CreatedAt: now},
		{Kind: model.AuditCommand, UserID: 2, Username: "bob", NodeID: uptr(1), ClientIP: "10.0.0.6", Payload: "sudo rm -rf /var/log", CreatedAt: now},
		{Kind: model.AuditLoginFailed, UserID: 3, Username: "carol", ClientIP: "10.0.0.7", Payload: "result=failed reason=bad password", CreatedAt: now},
		{Kind: model.AuditFileUpload, UserID: 1, Username: "alice", NodeID: uptr(1), ClientIP: "10.0.0.5", Payload: "/tmp/app.tar", CreatedAt: now},
		{Kind: model.AuditOSSDelete, UserID: 2, Username: "bob", ClientIP: "10.0.0.6", Payload: "bucket/key", CreatedAt: now},
		{Kind: model.AuditSessionStart, UserID: 1, Username: "alice", NodeID: uptr(1), ClientIP: "10.0.0.5", CreatedAt: now},
	}
	r := NewAuditRepo(db)
	if err := r.BatchInsert(context.Background(), rows); err != nil {
		t.Fatalf("seed audit: %v", err)
	}
	return r
}

func TestAuditRepoQueryFilters(t *testing.T) {
	db := newAuditTestDB(t)
	r := seedAudit(t, db)
	ctx := context.Background()

	count := func(f AuditFilter) int {
		n, err := r.Count(ctx, f)
		if err != nil {
			t.Fatalf("count: %v", err)
		}
		// Query must agree with Count on the same filter.
		rows, err := r.Query(ctx, f)
		if err != nil {
			t.Fatalf("query: %v", err)
		}
		if int64(len(rows)) != n && f.Limit == 0 {
			t.Fatalf("query len %d != count %d for %+v", len(rows), n, f)
		}
		return int(n)
	}

	if got := count(AuditFilter{}); got != 6 {
		t.Fatalf("total = %d, want 6", got)
	}
	if got := count(AuditFilter{Category: model.AuditCatCommand}); got != 2 {
		t.Fatalf("command category = %d, want 2", got)
	}
	if got := count(AuditFilter{OnlyAbnormal: true}); got != 3 {
		// dangerous rm -rf command + login_failed + oss.delete
		t.Fatalf("abnormal = %d, want 3", got)
	}
	if got := count(AuditFilter{NodeName: "web-01"}); got != 4 {
		t.Fatalf("node_name web-01 = %d, want 4", got)
	}
	if got := count(AuditFilter{Username: "ali"}); got != 3 {
		t.Fatalf("username ~ali = %d, want 3", got)
	}
	if got := count(AuditFilter{Category: model.AuditCatCommand, OnlyAbnormal: true}); got != 1 {
		t.Fatalf("abnormal commands = %d, want 1", got)
	}
	if got := count(AuditFilter{Q: "rm -rf"}); got != 1 {
		t.Fatalf("q rm -rf = %d, want 1", got)
	}
}

func TestAuditRepoAfter(t *testing.T) {
	db := newAuditTestDB(t)
	r := seedAudit(t, db)
	rows, err := r.After(context.Background(), 0, AuditFilter{}, 100)
	if err != nil {
		t.Fatalf("after: %v", err)
	}
	if len(rows) != 6 {
		t.Fatalf("after(0) = %d, want 6", len(rows))
	}
	// Ascending by id so the live tail emits oldest-first.
	for i := 1; i < len(rows); i++ {
		if rows[i].ID <= rows[i-1].ID {
			t.Fatalf("rows not ascending by id")
		}
	}
	// Only-abnormal stream increment.
	ab, err := r.After(context.Background(), 0, AuditFilter{OnlyAbnormal: true}, 100)
	if err != nil {
		t.Fatalf("after abnormal: %v", err)
	}
	if len(ab) != 3 {
		t.Fatalf("abnormal after = %d, want 3", len(ab))
	}
}

func TestAuditRepoStats(t *testing.T) {
	db := newAuditTestDB(t)
	r := seedAudit(t, db)
	st, err := r.Stats(context.Background(), 14)
	if err != nil {
		t.Fatalf("stats: %v", err)
	}
	if st.Total != 6 {
		t.Fatalf("total = %d, want 6", st.Total)
	}
	if st.Abnormal != 3 {
		t.Fatalf("abnormal = %d, want 3", st.Abnormal)
	}
	if st.ActiveUsers != 3 {
		t.Fatalf("active users = %d, want 3", st.ActiveUsers)
	}

	cat := map[string]int64{}
	for _, c := range st.ByCategory {
		cat[c.Key] = c.Count
	}
	if cat[model.AuditCatCommand] != 2 || cat[model.AuditCatFile] != 1 ||
		cat[model.AuditCatAuth] != 1 || cat[model.AuditCatOSS] != 1 || cat[model.AuditCatSession] != 1 {
		t.Fatalf("by_category wrong: %+v", cat)
	}
	if len(st.ByCategory) != len(model.AuditCategories) {
		t.Fatalf("by_category should list all %d lanes, got %d", len(model.AuditCategories), len(st.ByCategory))
	}

	if len(st.TopUsers) == 0 || st.TopUsers[0].Key != "alice" || st.TopUsers[0].Count != 3 {
		t.Fatalf("top users wrong: %+v", st.TopUsers)
	}
	if len(st.TopNodes) == 0 || st.TopNodes[0].Key != "web-01" || st.TopNodes[0].Count != 4 {
		t.Fatalf("top nodes wrong: %+v", st.TopNodes)
	}

	// Heatmap is a dense 7×24 grid that sums to the windowed total.
	if len(st.Heatmap) != 7 {
		t.Fatalf("heatmap rows = %d, want 7", len(st.Heatmap))
	}
	sum := 0
	for _, row := range st.Heatmap {
		if len(row) != 24 {
			t.Fatalf("heatmap row width = %d, want 24", len(row))
		}
		for _, v := range row {
			sum += v
		}
	}
	if sum != 6 {
		t.Fatalf("heatmap sum = %d, want 6", sum)
	}
}
