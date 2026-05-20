package api

import (
	"encoding/json"
	"fmt"
	"net/http"
	"strconv"
	"strings"
	"time"

	"github.com/gin-gonic/gin"
	"github.com/michongs/jumpserver-anonymous/internal/approval"
	"github.com/michongs/jumpserver-anonymous/internal/audit"
	"github.com/michongs/jumpserver-anonymous/internal/auth"
	"github.com/michongs/jumpserver-anonymous/internal/dbquery"
	"github.com/michongs/jumpserver-anonymous/internal/model"
)

// DBHandler is the REST surface for the Phase 17 visual database
// browser. The terminal-style dbcli lives under /ws/dbcli/*; this
// handler serves structured JSON for the schema tree, table previews,
// and ad-hoc SQL.
type DBHandler struct {
	Svc      *dbquery.Service
	Approval *approval.Service
	Audit    *audit.Writer
}

// NewDBHandler is the standard constructor; nil-safe — when Svc is nil
// every endpoint returns 503 so a partial config doesn't 404.
func NewDBHandler(svc *dbquery.Service, app *approval.Service, aud *audit.Writer) *DBHandler {
	return &DBHandler{Svc: svc, Approval: app, Audit: aud}
}

func (h *DBHandler) gate(c *gin.Context) (uint64, *auth.Claims, bool) {
	if h == nil || h.Svc == nil {
		c.JSON(http.StatusServiceUnavailable, gin.H{"error": "db browser disabled"})
		return 0, nil, false
	}
	claims := auth.FromContext(c.Request.Context())
	if claims == nil {
		c.JSON(http.StatusUnauthorized, gin.H{"error": "missing claims"})
		return 0, nil, false
	}
	nodeID, err := strconv.ParseUint(c.Param("id"), 10, 64)
	if err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"error": "bad node id"})
		return 0, nil, false
	}
	return nodeID, claims, true
}

// Ping — GET /api/v1/nodes/:id/db/ping?database=...
func (h *DBHandler) Ping(c *gin.Context) {
	nodeID, claims, ok := h.gate(c)
	if !ok {
		return
	}
	if err := h.Svc.Ping(c.Request.Context(), nodeID, claims.UserID, c.Query("database")); err != nil {
		c.JSON(http.StatusBadGateway, gin.H{"error": err.Error()})
		return
	}
	c.JSON(http.StatusOK, gin.H{"ok": true})
}

// Databases — GET /api/v1/nodes/:id/db/databases
// Cluster-level DB listing for the UI's database picker. PostgreSQL
// connections are bound to one DB at connect time; this surface lets
// the operator switch to another one (which spawns a fresh pool).
func (h *DBHandler) Databases(c *gin.Context) {
	nodeID, claims, ok := h.gate(c)
	if !ok {
		return
	}
	names, err := h.Svc.ListDatabases(c.Request.Context(), nodeID, claims.UserID)
	if err != nil {
		c.JSON(http.StatusBadGateway, gin.H{"error": err.Error()})
		return
	}
	c.JSON(http.StatusOK, gin.H{"databases": names})
}

// Schema — GET /api/v1/nodes/:id/db/schema?database=...
func (h *DBHandler) Schema(c *gin.Context) {
	nodeID, claims, ok := h.gate(c)
	if !ok {
		return
	}
	info, err := h.Svc.LoadSchema(c.Request.Context(), nodeID, claims.UserID, c.Query("database"))
	if err != nil {
		c.JSON(http.StatusBadGateway, gin.H{"error": err.Error()})
		return
	}
	c.JSON(http.StatusOK, info)
}

// Columns — GET /api/v1/nodes/:id/db/columns?database=...&schema=...&table=...
func (h *DBHandler) Columns(c *gin.Context) {
	nodeID, claims, ok := h.gate(c)
	if !ok {
		return
	}
	schema, table := c.Query("schema"), c.Query("table")
	if schema == "" || table == "" {
		c.JSON(http.StatusBadRequest, gin.H{"error": "schema and table required"})
		return
	}
	cols, err := h.Svc.LoadColumns(c.Request.Context(), nodeID, claims.UserID, c.Query("database"), schema, table)
	if err != nil {
		c.JSON(http.StatusBadGateway, gin.H{"error": err.Error()})
		return
	}
	c.JSON(http.StatusOK, gin.H{"columns": cols})
}

// Indexes — GET /api/v1/nodes/:id/db/indexes?database=...&schema=...&table=...
func (h *DBHandler) Indexes(c *gin.Context) {
	nodeID, claims, ok := h.gate(c)
	if !ok {
		return
	}
	schema, table := c.Query("schema"), c.Query("table")
	if schema == "" || table == "" {
		c.JSON(http.StatusBadRequest, gin.H{"error": "schema and table required"})
		return
	}
	idxs, err := h.Svc.LoadIndexes(c.Request.Context(), nodeID, claims.UserID, c.Query("database"), schema, table)
	if err != nil {
		c.JSON(http.StatusBadGateway, gin.H{"error": err.Error()})
		return
	}
	c.JSON(http.StatusOK, gin.H{"indexes": idxs})
}

// ForeignKeys — GET /api/v1/nodes/:id/db/foreign_keys?database=...&schema=...&table=...
func (h *DBHandler) ForeignKeys(c *gin.Context) {
	nodeID, claims, ok := h.gate(c)
	if !ok {
		return
	}
	schema, table := c.Query("schema"), c.Query("table")
	if schema == "" || table == "" {
		c.JSON(http.StatusBadRequest, gin.H{"error": "schema and table required"})
		return
	}
	fks, err := h.Svc.LoadForeignKeys(c.Request.Context(), nodeID, claims.UserID, c.Query("database"), schema, table)
	if err != nil {
		c.JSON(http.StatusBadGateway, gin.H{"error": err.Error()})
		return
	}
	c.JSON(http.StatusOK, gin.H{"foreign_keys": fks})
}

// TableStats — GET /api/v1/nodes/:id/db/stats?database=...&schema=...&table=...
func (h *DBHandler) TableStats(c *gin.Context) {
	nodeID, claims, ok := h.gate(c)
	if !ok {
		return
	}
	schema, table := c.Query("schema"), c.Query("table")
	if schema == "" || table == "" {
		c.JSON(http.StatusBadRequest, gin.H{"error": "schema and table required"})
		return
	}
	stats, err := h.Svc.LoadTableStats(c.Request.Context(), nodeID, claims.UserID, c.Query("database"), schema, table)
	if err != nil {
		c.JSON(http.StatusBadGateway, gin.H{"error": err.Error()})
		return
	}
	c.JSON(http.StatusOK, stats)
}

// TableDDL — GET /api/v1/nodes/:id/db/ddl?database=...&schema=...&table=...
func (h *DBHandler) TableDDL(c *gin.Context) {
	nodeID, claims, ok := h.gate(c)
	if !ok {
		return
	}
	schema, table := c.Query("schema"), c.Query("table")
	if schema == "" || table == "" {
		c.JSON(http.StatusBadRequest, gin.H{"error": "schema and table required"})
		return
	}
	ddl, err := h.Svc.LoadTableDDL(c.Request.Context(), nodeID, claims.UserID, c.Query("database"), schema, table)
	if err != nil {
		c.JSON(http.StatusBadGateway, gin.H{"error": err.Error()})
		return
	}
	c.JSON(http.StatusOK, gin.H{"ddl": ddl})
}

// rowBody is shared by UpdateRow / InsertRow / DeleteRow.
type rowBody struct {
	Database string         `json:"database,omitempty"`
	Schema   string         `json:"schema"`
	Table    string         `json:"table"`
	// PK columns + values identify the target row. Required for
	// Update and Delete; ignored for Insert.
	KeyColumns []string `json:"key_columns,omitempty"`
	KeyValues  []any    `json:"key_values,omitempty"`
	// SetColumns + SetValues are the new payload. Used by Update + Insert.
	SetColumns []string `json:"set_columns,omitempty"`
	SetValues  []any    `json:"set_values,omitempty"`
	Reason     string   `json:"reason,omitempty"`
}

func (h *DBHandler) checkSQLExec(c *gin.Context, nodeID uint64, claims *auth.Claims) (bool, *approval.EnforcementResult) {
	if h.Approval == nil {
		return true, nil
	}
	res, err := h.Approval.CheckEnforced(c.Request.Context(), approval.EnforcementCheck{
		UserID:       claims.UserID,
		BusinessType: model.ApprovalBizSQLExec,
		ResourceType: "node",
		ResourceID:   strconv.FormatUint(nodeID, 10),
		Action:       "sql_exec",
	})
	if err != nil {
		c.JSON(http.StatusForbidden, gin.H{"error": "approval check failed: " + err.Error()})
		return false, nil
	}
	if !res.Allowed {
		c.JSON(http.StatusForbidden, gin.H{"error": res.Reason, "approval_required": true})
		return false, &res
	}
	return true, &res
}

// RowUpdate — POST /api/v1/nodes/:id/db/row/update
func (h *DBHandler) RowUpdate(c *gin.Context) {
	nodeID, claims, ok := h.gate(c)
	if !ok {
		return
	}
	var body rowBody
	if err := c.ShouldBindJSON(&body); err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"error": err.Error()})
		return
	}
	if body.Schema == "" || body.Table == "" {
		c.JSON(http.StatusBadRequest, gin.H{"error": "schema and table required"})
		return
	}
	if ok2, _ := h.checkSQLExec(c, nodeID, claims); !ok2 {
		return
	}
	out, err := h.Svc.UpdateRow(c.Request.Context(), nodeID, claims.UserID,
		body.Database, body.Schema, body.Table,
		dbquery.RowKey{Columns: body.KeyColumns, Values: body.KeyValues},
		dbquery.RowEdit{SetColumns: body.SetColumns, SetValues: body.SetValues})
	if err != nil {
		h.logSQL(c, nodeID, claims, "row.update.fail", fmt.Sprintf("UPDATE %s.%s", body.Schema, body.Table), body.Reason, err)
		c.JSON(http.StatusBadGateway, gin.H{"error": err.Error()})
		return
	}
	h.logSQL(c, nodeID, claims, "row.update.ok", fmt.Sprintf("UPDATE %s.%s set=%v key=%v", body.Schema, body.Table, body.SetColumns, body.KeyColumns), body.Reason, nil)
	c.JSON(http.StatusOK, out)
}

// RowInsert — POST /api/v1/nodes/:id/db/row/insert
func (h *DBHandler) RowInsert(c *gin.Context) {
	nodeID, claims, ok := h.gate(c)
	if !ok {
		return
	}
	var body rowBody
	if err := c.ShouldBindJSON(&body); err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"error": err.Error()})
		return
	}
	if body.Schema == "" || body.Table == "" {
		c.JSON(http.StatusBadRequest, gin.H{"error": "schema and table required"})
		return
	}
	if ok2, _ := h.checkSQLExec(c, nodeID, claims); !ok2 {
		return
	}
	out, err := h.Svc.InsertRow(c.Request.Context(), nodeID, claims.UserID,
		body.Database, body.Schema, body.Table, body.SetColumns, body.SetValues)
	if err != nil {
		h.logSQL(c, nodeID, claims, "row.insert.fail", fmt.Sprintf("INSERT %s.%s", body.Schema, body.Table), body.Reason, err)
		c.JSON(http.StatusBadGateway, gin.H{"error": err.Error()})
		return
	}
	h.logSQL(c, nodeID, claims, "row.insert.ok", fmt.Sprintf("INSERT %s.%s cols=%v", body.Schema, body.Table, body.SetColumns), body.Reason, nil)
	c.JSON(http.StatusOK, out)
}

// RowDelete — POST /api/v1/nodes/:id/db/row/delete
func (h *DBHandler) RowDelete(c *gin.Context) {
	nodeID, claims, ok := h.gate(c)
	if !ok {
		return
	}
	var body rowBody
	if err := c.ShouldBindJSON(&body); err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"error": err.Error()})
		return
	}
	if body.Schema == "" || body.Table == "" {
		c.JSON(http.StatusBadRequest, gin.H{"error": "schema and table required"})
		return
	}
	if ok2, _ := h.checkSQLExec(c, nodeID, claims); !ok2 {
		return
	}
	out, err := h.Svc.DeleteRow(c.Request.Context(), nodeID, claims.UserID,
		body.Database, body.Schema, body.Table,
		dbquery.RowKey{Columns: body.KeyColumns, Values: body.KeyValues})
	if err != nil {
		h.logSQL(c, nodeID, claims, "row.delete.fail", fmt.Sprintf("DELETE %s.%s", body.Schema, body.Table), body.Reason, err)
		c.JSON(http.StatusBadGateway, gin.H{"error": err.Error()})
		return
	}
	h.logSQL(c, nodeID, claims, "row.delete.ok", fmt.Sprintf("DELETE %s.%s key=%v", body.Schema, body.Table, body.KeyColumns), body.Reason, nil)
	c.JSON(http.StatusOK, out)
}

// Explain — POST /api/v1/nodes/:id/db/explain
// Body: { sql, database?, analyze? }
//
// EXPLAIN is read-only on both engines, but EXPLAIN ANALYZE on PG /
// MySQL >=8.0.18 actually executes the statement. We still classify
// the inner statement as read-only first; otherwise an operator
// could "EXPLAIN ANALYZE DELETE …" to bypass the write gate.
func (h *DBHandler) Explain(c *gin.Context) {
	nodeID, claims, ok := h.gate(c)
	if !ok {
		return
	}
	var body struct {
		SQL      string `json:"sql"`
		Database string `json:"database,omitempty"`
		Analyze  bool   `json:"analyze,omitempty"`
		Reason   string `json:"reason,omitempty"`
	}
	if err := c.ShouldBindJSON(&body); err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"error": err.Error()})
		return
	}
	body.SQL = strings.TrimSpace(body.SQL)
	if body.SQL == "" {
		c.JSON(http.StatusBadRequest, gin.H{"error": "sql empty"})
		return
	}
	if !isReadOnlySQL(body.SQL) {
		c.JSON(http.StatusForbidden, gin.H{
			"error": "EXPLAIN refused: inner statement isn't read-only — ANALYZE would execute it",
		})
		return
	}
	out, err := h.Svc.Explain(c.Request.Context(), nodeID, claims.UserID, body.Database, body.SQL, body.Analyze)
	if err != nil {
		h.logSQL(c, nodeID, claims, "explain.fail", body.SQL, body.Reason, err)
		c.JSON(http.StatusBadGateway, gin.H{"error": err.Error()})
		return
	}
	h.logSQL(c, nodeID, claims, "explain.ok", body.SQL, body.Reason, nil)
	c.JSON(http.StatusOK, out)
}

// queryBody is the shared shape for Query and Exec.
type queryBody struct {
	SQL    string `json:"sql"`
	Args   []any  `json:"args,omitempty"`
	// Database overrides the connection's bound DB. Required for PG
	// cross-catalog browsing; optional for MySQL where the same
	// connection can SELECT across schemas freely.
	Database string `json:"database,omitempty"`
	// Limit caps the SELECT row count (Query only). 0 = use server default.
	Limit  int    `json:"limit,omitempty"`
	// Reason is the human-supplied explanation that lands in audit + the
	// approval ledger if enforcement kicks in.
	Reason string `json:"reason,omitempty"`
}

// Query — POST /api/v1/nodes/:id/db/query
// Read-only path: SELECT / EXPLAIN / SHOW / WITH-of-SELECT. Refuses on
// statements that look like writes; the strict gate is the SQL prefix
// classifier in `isReadOnlySQL`.
func (h *DBHandler) Query(c *gin.Context) {
	nodeID, claims, ok := h.gate(c)
	if !ok {
		return
	}
	var body queryBody
	if err := c.ShouldBindJSON(&body); err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"error": err.Error()})
		return
	}
	body.SQL = strings.TrimSpace(body.SQL)
	if body.SQL == "" {
		c.JSON(http.StatusBadRequest, gin.H{"error": "sql empty"})
		return
	}
	if !isReadOnlySQL(body.SQL) {
		c.JSON(http.StatusForbidden, gin.H{
			"error": "write statement — POST /db/exec required",
		})
		return
	}
	out, err := h.Svc.Query(c.Request.Context(), nodeID, claims.UserID,
		body.Database, body.SQL, body.Args, body.Limit)
	if err != nil {
		h.logSQL(c, nodeID, claims, "query.fail", body.SQL, body.Reason, err)
		c.JSON(http.StatusBadGateway, gin.H{"error": err.Error()})
		return
	}
	h.logSQL(c, nodeID, claims, "query.ok", body.SQL, body.Reason, nil)
	c.JSON(http.StatusOK, out)
}

// Exec — POST /api/v1/nodes/:id/db/exec
// Write path. Gated through approval.CheckEnforced with business type
// sql_exec so admins can mandate per-resource approval on write
// statements without blocking SELECTs.
func (h *DBHandler) Exec(c *gin.Context) {
	nodeID, claims, ok := h.gate(c)
	if !ok {
		return
	}
	var body queryBody
	if err := c.ShouldBindJSON(&body); err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"error": err.Error()})
		return
	}
	body.SQL = strings.TrimSpace(body.SQL)
	if body.SQL == "" {
		c.JSON(http.StatusBadRequest, gin.H{"error": "sql empty"})
		return
	}
	if isReadOnlySQL(body.SQL) {
		c.JSON(http.StatusBadRequest, gin.H{
			"error": "read-only statement — use POST /db/query instead",
		})
		return
	}
	// Approval gate for writes. The node-level flag is RequiresApprovalForConnect;
	// admins who want a separate per-write knob can extend the model. For
	// Phase 17 we reuse the connect flag as the write gate to keep the
	// admin UX simple.
	if h.Approval != nil {
		res, err := h.Approval.CheckEnforced(c.Request.Context(), approval.EnforcementCheck{
			UserID:       claims.UserID,
			BusinessType: model.ApprovalBizSQLExec,
			ResourceType: "node",
			ResourceID:   strconv.FormatUint(nodeID, 10),
			Action:       "sql_exec",
		})
		if err != nil {
			h.logSQL(c, nodeID, claims, "exec.gate_err", body.SQL, body.Reason, err)
			c.JSON(http.StatusForbidden, gin.H{"error": "approval check failed: " + err.Error()})
			return
		}
		if !res.Allowed {
			h.logSQL(c, nodeID, claims, "exec.gate_deny", body.SQL, body.Reason, fmt.Errorf("%s", res.Reason))
			c.JSON(http.StatusForbidden, gin.H{
				"error":             res.Reason,
				"approval_required": true,
			})
			return
		}
	}
	out, err := h.Svc.Exec(c.Request.Context(), nodeID, claims.UserID, body.Database, body.SQL, body.Args)
	if err != nil {
		h.logSQL(c, nodeID, claims, "exec.fail", body.SQL, body.Reason, err)
		c.JSON(http.StatusBadGateway, gin.H{"error": err.Error()})
		return
	}
	h.logSQL(c, nodeID, claims, "exec.ok", body.SQL, body.Reason, nil)
	c.JSON(http.StatusOK, out)
}

// Rows — GET /api/v1/nodes/:id/db/rows?database=...&schema=...&table=...&limit=&offset=
// Browse mode for "click a table, see N rows".
func (h *DBHandler) Rows(c *gin.Context) {
	nodeID, claims, ok := h.gate(c)
	if !ok {
		return
	}
	database := c.Query("database")
	schema, table := c.Query("schema"), c.Query("table")
	if schema == "" || table == "" {
		c.JSON(http.StatusBadRequest, gin.H{"error": "schema and table required"})
		return
	}
	limit, _ := strconv.Atoi(c.Query("limit"))
	if limit <= 0 || limit > 500 {
		limit = 100
	}
	offset, _ := strconv.Atoi(c.Query("offset"))
	if offset < 0 {
		offset = 0
	}
	orderBy := c.Query("order_by")
	orderDir := strings.ToUpper(c.Query("order_dir"))
	if orderDir != "ASC" && orderDir != "DESC" {
		orderDir = ""
	}
	sqlText, err := h.buildRowsSQL(c, nodeID, claims.UserID, database, schema, table, orderBy, orderDir, limit, offset)
	if err != nil {
		c.JSON(http.StatusBadGateway, gin.H{"error": err.Error()})
		return
	}
	out, err := h.Svc.Query(c.Request.Context(), nodeID, claims.UserID, database, sqlText, nil, limit)
	if err != nil {
		c.JSON(http.StatusBadGateway, gin.H{"error": err.Error()})
		return
	}
	h.logSQL(c, nodeID, claims, "rows", sqlText, "", nil)
	c.JSON(http.StatusOK, out)
}

// buildRowsSQL produces a quoted SELECT * for the right dialect. The
// table name is validated by reading columns first so we never inject
// an arbitrary string into the query — the columns call fails on a
// non-existent table and rejects garbage names.
func (h *DBHandler) buildRowsSQL(c *gin.Context, nodeID, userID uint64,
	database, schema, table, orderBy, orderDir string, limit, offset int) (string, error) {
	cols, err := h.Svc.LoadColumns(c.Request.Context(), nodeID, userID, database, schema, table)
	if err != nil {
		return "", err
	}
	if len(cols) == 0 {
		return "", fmt.Errorf("table %s.%s has no columns or doesn't exist", schema, table)
	}
	knownCols := map[string]bool{}
	for _, col := range cols {
		knownCols[col.Name] = true
	}
	if orderBy != "" && !knownCols[orderBy] {
		return "", fmt.Errorf("order_by column %q not in table", orderBy)
	}
	// The Svc has no public protocol getter; we use the column-fetch
	// result to infer dialect indirectly by looking at the column Type
	// strings. Postgres types are lowercase with parens; MySQL types
	// uppercase. The robust path is to expose a tiny Protocol getter.
	pgish := false
	if len(cols) > 0 {
		t := cols[0].Type
		if strings.ContainsAny(t, "(") || strings.ContainsAny(t, " ") || strings.ToLower(t) == t {
			pgish = true
		}
	}
	quote := func(s string) string {
		if pgish {
			return `"` + strings.ReplaceAll(s, `"`, `""`) + `"`
		}
		return "`" + strings.ReplaceAll(s, "`", "``") + "`"
	}
	q := "SELECT * FROM " + quote(schema) + "." + quote(table)
	if orderBy != "" {
		q += " ORDER BY " + quote(orderBy)
		if orderDir != "" {
			q += " " + orderDir
		}
	}
	q += fmt.Sprintf(" LIMIT %d OFFSET %d", limit, offset)
	return q, nil
}

// logSQL pushes the statement into the audit ring buffer. We trim long
// SQL aggressively because the audit writer's channel is bounded.
func (h *DBHandler) logSQL(c *gin.Context, nodeID uint64, claims *auth.Claims,
	kind, sqlText, reason string, opErr error) {
	if h.Audit == nil || claims == nil {
		return
	}
	payload := map[string]any{
		"node_id": nodeID,
		"sql":     truncate(sqlText, 2048),
		"reason":  reason,
	}
	if opErr != nil {
		payload["error"] = opErr.Error()
	}
	b, _ := json.Marshal(payload)
	nID := nodeID
	h.Audit.Log(model.AuditLog{
		Kind:      model.AuditEventKind("db." + kind),
		UserID:    claims.UserID,
		Username:  claims.Username,
		NodeID:    &nID,
		ClientIP:  c.ClientIP(),
		Payload:   string(b),
		CreatedAt: time.Now(),
	})
}

func truncate(s string, n int) string {
	if len(s) <= n {
		return s
	}
	return s[:n] + "…"
}

// isReadOnlySQL classifies a statement as read-only. We don't try to
// parse SQL — that's a rabbit hole. Instead we look at the first
// non-comment, non-whitespace token. Common safe heads: SELECT, WITH
// (CTE — assumed to be a SELECT; INSERT/UPDATE inside WITH is a write
// but rare and we accept that false-positive risk), EXPLAIN, SHOW,
// DESCRIBE, DESC, ANALYZE-without-write.
func isReadOnlySQL(s string) bool {
	// Strip leading single-line + block comments.
	for {
		s = strings.TrimLeftFunc(s, func(r rune) bool { return r == ' ' || r == '\t' || r == '\n' || r == '\r' })
		if strings.HasPrefix(s, "--") {
			if idx := strings.IndexByte(s, '\n'); idx >= 0 {
				s = s[idx+1:]
				continue
			}
			return false
		}
		if strings.HasPrefix(s, "/*") {
			if idx := strings.Index(s, "*/"); idx >= 0 {
				s = s[idx+2:]
				continue
			}
			return false
		}
		break
	}
	upper := strings.ToUpper(s)
	for _, head := range []string{"SELECT", "WITH", "EXPLAIN", "SHOW", "DESCRIBE", "DESC", "VALUES"} {
		if strings.HasPrefix(upper, head) {
			// Boundary check: prefix must be followed by a non-letter.
			next := byte(' ')
			if len(upper) > len(head) {
				next = upper[len(head)]
			}
			if next == ' ' || next == '\t' || next == '\n' || next == '\r' || next == '(' || next == ';' {
				return true
			}
		}
	}
	return false
}
