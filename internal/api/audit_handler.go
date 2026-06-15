package api

import (
	"context"
	"encoding/csv"
	"encoding/json"
	"net/http"
	"strconv"
	"time"

	"github.com/gin-gonic/gin"
	"github.com/michongs/jumpserver-anonymous/internal/audit"
	"github.com/michongs/jumpserver-anonymous/internal/model"
	"github.com/michongs/jumpserver-anonymous/internal/repo"
	"github.com/michongs/jumpserver-anonymous/internal/sse"
)

// maxIntegrityRows caps how many rows the verifier loads per chain so a vast log
// can't OOM the report. A chain longer than this is verified up to the cap and
// flagged truncated.
const maxIntegrityRows = 200000

// Integrity recomputes the tamper-evidence hash chain (security-architecture.md
// §5.2) and reports, per chain, whether it is intact plus its signed
// checkpoints. With ?chain_id=X it reports that chain only; otherwise every
// chain present in the log. Pre-M4 rows carry no chain id and are reported as an
// explicitly unprotected segment rather than silently "passing".
func (h *AuditHandler) Integrity(c *gin.Context) {
	ctx := c.Request.Context()
	chainID := c.Query("chain_id")

	var chains []string
	if chainID != "" {
		chains = []string{chainID}
	} else {
		ids, err := h.Repo.DistinctChains(ctx)
		if err != nil {
			c.JSON(http.StatusInternalServerError, gin.H{"error": err.Error()})
			return
		}
		chains = ids
	}

	type checkpointView struct {
		Day          string `json:"day"`
		TailHash     string `json:"tail_hash"`
		EntryCount   int64  `json:"entry_count"`
		DroppedCount int64  `json:"dropped_count"`
		IsGenesis    bool   `json:"is_genesis"`
		Signed       bool   `json:"signed"`
		CreatedAt    string `json:"created_at"`
	}
	type chainReport struct {
		ChainID     string           `json:"chain_id"`
		EntryCount  int              `json:"entry_count"`
		Intact      bool             `json:"intact"`
		BrokenAt    int              `json:"broken_at"` // -1 when intact
		Truncated   bool             `json:"truncated"`
		Checkpoints []checkpointView `json:"checkpoints"`
	}

	reports := make([]chainReport, 0, len(chains))
	for _, id := range chains {
		rows, err := h.Repo.ChainRows(ctx, id, maxIntegrityRows)
		if err != nil {
			c.JSON(http.StatusInternalServerError, gin.H{"error": err.Error()})
			return
		}
		intact, brokenAt := audit.VerifyChain(rows)
		cps, _ := h.Repo.ListCheckpoints(ctx, id)
		cvs := make([]checkpointView, 0, len(cps))
		for _, cp := range cps {
			cvs = append(cvs, checkpointView{
				Day: cp.Day, TailHash: cp.TailHash, EntryCount: cp.EntryCount,
				DroppedCount: cp.DroppedCount, IsGenesis: cp.IsGenesis,
				Signed:    len(cp.Signature) > 0,
				CreatedAt: cp.CreatedAt.Format(time.RFC3339),
			})
		}
		reports = append(reports, chainReport{
			ChainID: id, EntryCount: len(rows), Intact: intact, BrokenAt: brokenAt,
			Truncated: len(rows) >= maxIntegrityRows, Checkpoints: cvs,
		})
	}

	// Surface the unprotected pre-M4 segment honestly (rows with no chain id).
	unprotected, _ := h.Repo.CountUnchained(ctx)

	c.JSON(http.StatusOK, gin.H{
		"chains":           reports,
		"unprotected_rows": unprotected,
		"unprotected_note": "链 ID 为空的历史行(M4 上线前)不在防篡改保护范围内",
	})
}

// AuditHandler exposes the global audit trail: a filtered/paginated list, an
// overview aggregation, a live SSE tail, and a CSV export. All endpoints are
// gated by auth.PermAuditRead at the route layer.
type AuditHandler struct {
	Repo  *repo.AuditRepo
	Nodes *repo.NodeRepo // optional; enriches node_id → asset name
}

// auditRow is one audit event decorated with the derived fields the UI needs
// (category lane, abnormal flag, resolved asset name) so the frontend and the
// backend never disagree on what counts as abnormal.
type auditRow struct {
	model.AuditLog
	Category string `json:"category"`
	Abnormal bool   `json:"abnormal"`
	NodeName string `json:"node_name,omitempty"`
}

// parseFilter builds an AuditFilter from the request query. Shared by List,
// Stream, and Export so they always scope identically.
func (h *AuditHandler) parseFilter(c *gin.Context) repo.AuditFilter {
	f := repo.AuditFilter{
		Category:  c.Query("category"),
		Username:  c.Query("username"),
		SessionID: c.Query("session_id"),
		NodeName:  c.Query("node_name"),
		ClientIP:  c.Query("client_ip"),
		Q:         c.Query("q"),
	}
	if c.Query("only_abnormal") == "1" || c.Query("only_abnormal") == "true" {
		f.OnlyAbnormal = true
	}
	if raw := c.QueryArray("kind"); len(raw) > 0 {
		f.Kinds = raw
	}
	if raw := c.Query("user_id"); raw != "" {
		if v, err := strconv.ParseUint(raw, 10, 64); err == nil {
			f.UserID = v
		}
	}
	if raw := c.Query("node_id"); raw != "" {
		if v, err := strconv.ParseUint(raw, 10, 64); err == nil {
			f.NodeID = &v
		}
	}
	if raw := c.Query("from"); raw != "" {
		if t, err := time.Parse(time.RFC3339, raw); err == nil {
			f.From = &t
		}
	}
	if raw := c.Query("to"); raw != "" {
		if t, err := time.Parse(time.RFC3339, raw); err == nil {
			f.To = &t
		}
	}
	return f
}

// enrich decorates raw rows with category/abnormal/node-name in a single batch
// node lookup.
func (h *AuditHandler) enrich(ctx context.Context, rows []model.AuditLog) []auditRow {
	names := map[uint64]string{}
	if h.Nodes != nil {
		var ids []uint64
		seen := map[uint64]struct{}{}
		for _, r := range rows {
			if r.NodeID != nil {
				if _, ok := seen[*r.NodeID]; !ok {
					seen[*r.NodeID] = struct{}{}
					ids = append(ids, *r.NodeID)
				}
			}
		}
		if len(ids) > 0 {
			if m, err := h.Nodes.NamesByIDs(ctx, ids); err == nil {
				names = m
			}
		}
	}
	out := make([]auditRow, 0, len(rows))
	for _, r := range rows {
		row := auditRow{AuditLog: r, Category: model.AuditCategoryOf(string(r.Kind)), Abnormal: r.IsAbnormal()}
		if r.NodeID != nil {
			row.NodeName = names[*r.NodeID]
		}
		out = append(out, row)
	}
	return out
}

// List — GET /audit-logs. Filtered page + total.
func (h *AuditHandler) List(c *gin.Context) {
	f := h.parseFilter(c)
	if raw := c.Query("limit"); raw != "" {
		if v, err := strconv.Atoi(raw); err == nil {
			f.Limit = v
		}
	}
	if raw := c.Query("offset"); raw != "" {
		if v, err := strconv.Atoi(raw); err == nil {
			f.Offset = v
		}
	}
	rows, err := h.Repo.Query(c.Request.Context(), f)
	if err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": err.Error()})
		return
	}
	total, err := h.Repo.Count(c.Request.Context(), f)
	if err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": err.Error()})
		return
	}
	c.JSON(http.StatusOK, gin.H{"audit_logs": h.enrich(c.Request.Context(), rows), "total": total})
}

// Stats — GET /audit-logs/stats?days=14.
func (h *AuditHandler) Stats(c *gin.Context) {
	days, _ := strconv.Atoi(c.DefaultQuery("days", "14"))
	st, err := h.Repo.Stats(c.Request.Context(), days)
	if err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": err.Error()})
		return
	}
	c.JSON(http.StatusOK, st)
}

// Stream — GET /audit-logs/stream. Server-Sent Events tail: emits each new
// matching event as an `event: append` frame. Starts from the current MAX(id)
// so only genuinely new rows arrive. Teardown is driven by client disconnect.
func (h *AuditHandler) Stream(c *gin.Context) {
	f := h.parseFilter(c)
	lastID, err := h.Repo.MaxID(c.Request.Context())
	if err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": err.Error()})
		return
	}

	sse.WriteHeaders(c)
	ctx := c.Request.Context()
	if !sse.Frame(c, "ready", strconv.FormatUint(lastID, 10)) {
		return
	}

	poll := time.NewTicker(2 * time.Second)
	defer poll.Stop()
	ping := time.NewTicker(15 * time.Second)
	defer ping.Stop()

	for {
		select {
		case <-ctx.Done():
			return
		case <-poll.C:
			rows, err := h.Repo.After(ctx, lastID, f, 200)
			if err != nil || len(rows) == 0 {
				continue
			}
			for _, row := range h.enrich(ctx, rows) {
				b, _ := json.Marshal(row)
				if !sse.Frame(c, "append", string(b)) {
					return
				}
			}
			lastID = rows[len(rows)-1].ID
		case <-ping.C:
			if !sse.Ping(c) {
				return
			}
		}
	}
}

// Export — GET /audit-logs/export. Streams the filtered trail as CSV with a
// UTF-8 BOM and Chinese headers so Excel opens it cleanly. Pages through the
// result in chunks up to a hard cap to keep memory flat.
func (h *AuditHandler) Export(c *gin.Context) {
	f := h.parseFilter(c)
	c.Header("Content-Type", "text/csv; charset=utf-8")
	c.Header("Content-Disposition", "attachment; filename=\"audit-logs.csv\"")
	c.Writer.WriteHeader(http.StatusOK)
	_, _ = c.Writer.WriteString("\xEF\xBB\xBF") // UTF-8 BOM

	w := csv.NewWriter(c.Writer)
	_ = w.Write([]string{"时间", "类别", "事件", "是否异常", "用户", "来源IP", "资产", "会话", "详情"})

	const pageSize = 1000
	const hardCap = 100000
	f.Limit = pageSize
	f.Offset = 0
	written := 0
	for f.Offset < hardCap {
		rows, err := h.Repo.Query(c.Request.Context(), f)
		if err != nil || len(rows) == 0 {
			break
		}
		for _, row := range h.enrich(c.Request.Context(), rows) {
			abnormal := "正常"
			if row.Abnormal {
				abnormal = "异常"
			}
			_ = w.Write([]string{
				row.CreatedAt.Local().Format("2006-01-02 15:04:05"),
				row.Category,
				string(row.Kind),
				abnormal,
				row.Username,
				row.ClientIP,
				row.NodeName,
				row.SessionID,
				row.Payload,
			})
			written++
		}
		w.Flush()
		if len(rows) < pageSize {
			break
		}
		f.Offset += pageSize
	}
	w.Flush()
	_ = written
}
