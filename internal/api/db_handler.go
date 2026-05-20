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
	Database string `json:"database,omitempty"`
	Schema   string `json:"schema"`
	Table    string `json:"table"`
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
	if sqlHead(body.SQL) == "EXPLAIN" {
		c.JSON(http.StatusBadRequest, gin.H{"error": "provide the statement to explain without an EXPLAIN prefix"})
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

// Processes — GET /api/v1/nodes/:id/db/processes?database=...
func (h *DBHandler) Processes(c *gin.Context) {
	nodeID, claims, ok := h.gate(c)
	if !ok {
		return
	}
	procs, err := h.Svc.ListProcesses(c.Request.Context(), nodeID, claims.UserID, c.Query("database"))
	if err != nil {
		c.JSON(http.StatusBadGateway, gin.H{"error": err.Error()})
		return
	}
	c.JSON(http.StatusOK, gin.H{"processes": procs})
}

// Kill — POST /api/v1/nodes/:id/db/kill?database=...&pid=
// Approval (sql_exec) gated — killing other sessions is a write-class
// action even though no rows change.
func (h *DBHandler) Kill(c *gin.Context) {
	nodeID, claims, ok := h.gate(c)
	if !ok {
		return
	}
	pid, _ := strconv.ParseInt(c.Query("pid"), 10, 64)
	if pid <= 0 {
		c.JSON(http.StatusBadRequest, gin.H{"error": "pid required"})
		return
	}
	if ok2, _ := h.checkSQLExec(c, nodeID, claims); !ok2 {
		return
	}
	cancelled, err := h.Svc.CancelProcess(c.Request.Context(), nodeID, claims.UserID, c.Query("database"), pid)
	if err != nil {
		c.JSON(http.StatusBadGateway, gin.H{"error": err.Error()})
		return
	}
	h.logSQL(c, nodeID, claims, "kill", fmt.Sprintf("KILL %d", pid), "", nil)
	c.JSON(http.StatusOK, gin.H{"cancelled": cancelled})
}

// Export — GET /api/v1/nodes/:id/db/export?database=&schema=&table=&format=&limit=
// Streams the table contents (no pagination) straight to the client as
// CSV, JSON Lines, or SQL INSERTs. Server-side streaming so 10 GB
// tables don't OOM the gateway.
func (h *DBHandler) Export(c *gin.Context) {
	nodeID, claims, ok := h.gate(c)
	if !ok {
		return
	}
	schema, table := c.Query("schema"), c.Query("table")
	if schema == "" || table == "" {
		c.JSON(http.StatusBadRequest, gin.H{"error": "schema and table required"})
		return
	}
	format := strings.ToLower(c.Query("format"))
	if format == "" {
		format = "csv"
	}
	limit, _ := strconv.Atoi(c.Query("limit"))

	w := c.Writer
	switch format {
	case "csv":
		w.Header().Set("Content-Type", "text/csv; charset=utf-8")
		w.Header().Set("Content-Disposition", fmt.Sprintf(`attachment; filename="%s.%s.csv"`, schema, table))
	case "jsonl":
		w.Header().Set("Content-Type", "application/x-ndjson; charset=utf-8")
		w.Header().Set("Content-Disposition", fmt.Sprintf(`attachment; filename="%s.%s.jsonl"`, schema, table))
	case "sql":
		w.Header().Set("Content-Type", "text/plain; charset=utf-8")
		w.Header().Set("Content-Disposition", fmt.Sprintf(`attachment; filename="%s.%s.sql"`, schema, table))
	default:
		c.JSON(http.StatusBadRequest, gin.H{"error": "format must be csv|jsonl|sql"})
		return
	}
	w.WriteHeader(http.StatusOK)

	rowsWritten := 0
	headerWritten := false
	err := h.Svc.StreamExport(c.Request.Context(), nodeID, claims.UserID,
		c.Query("database"), schema, table, limit,
		func(cols []dbquery.ColumnMeta, row []any) error {
			if !headerWritten {
				if err := writeExportHeader(w, format, schema, table, cols); err != nil {
					return err
				}
				headerWritten = true
			}
			rowsWritten++
			return writeExportRow(w, format, schema, table, cols, row)
		})

	// We've already streamed bytes — can't change the status code now.
	// Append an error footer so the downloader sees the failure.
	if err != nil {
		_, _ = w.Write([]byte("\n-- export failed: " + err.Error() + "\n"))
	}
	h.logSQL(c, nodeID, claims, "export", fmt.Sprintf("EXPORT %s.%s (%s, %d rows)", schema, table, format, rowsWritten), "", err)
}

func writeExportHeader(w gin.ResponseWriter, format, schema, table string, cols []dbquery.ColumnMeta) error {
	switch format {
	case "csv":
		names := make([]string, len(cols))
		for i, c := range cols {
			names[i] = csvEscape(c.Name)
		}
		_, err := fmt.Fprintln(w, strings.Join(names, ","))
		return err
	case "sql":
		_, err := fmt.Fprintf(w, "-- export of %s.%s, generated %s\n", schema, table, time.Now().UTC().Format(time.RFC3339))
		return err
	}
	return nil
}

func writeExportRow(w gin.ResponseWriter, format, schema, table string, cols []dbquery.ColumnMeta, row []any) error {
	switch format {
	case "csv":
		fields := make([]string, len(row))
		for i, v := range row {
			fields[i] = csvEscape(fmt.Sprint(orEmpty(v)))
		}
		_, err := fmt.Fprintln(w, strings.Join(fields, ","))
		return err
	case "jsonl":
		obj := make(map[string]any, len(row))
		for i, v := range row {
			obj[cols[i].Name] = v
		}
		b, err := json.Marshal(obj)
		if err != nil {
			return err
		}
		_, err = w.Write(append(b, '\n'))
		return err
	case "sql":
		quoted := make([]string, len(row))
		for i, v := range row {
			quoted[i] = sqlLiteral(v)
		}
		names := make([]string, len(cols))
		for i, c := range cols {
			names[i] = `"` + strings.ReplaceAll(c.Name, `"`, `""`) + `"`
		}
		_, err := fmt.Fprintf(w, "INSERT INTO %s.%s (%s) VALUES (%s);\n",
			`"`+schema+`"`, `"`+table+`"`,
			strings.Join(names, ", "), strings.Join(quoted, ", "))
		return err
	}
	return nil
}

func orEmpty(v any) any {
	if v == nil {
		return ""
	}
	return v
}

func csvEscape(s string) string {
	if !strings.ContainsAny(s, `,"`+"\n\r") {
		return s
	}
	return `"` + strings.ReplaceAll(s, `"`, `""`) + `"`
}

// sqlLiteral renders a value as a SQL literal for the export-to-SQL
// format. Strings escape single quotes; numbers and bools pass through;
// nil → NULL. Postgres / MySQL both accept the resulting syntax.
func sqlLiteral(v any) string {
	if v == nil {
		return "NULL"
	}
	switch x := v.(type) {
	case bool:
		if x {
			return "TRUE"
		}
		return "FALSE"
	case int, int32, int64, uint, uint32, uint64, float32, float64:
		return fmt.Sprintf("%v", x)
	case string:
		return "'" + strings.ReplaceAll(x, "'", "''") + "'"
	}
	b, _ := json.Marshal(v)
	return "'" + strings.ReplaceAll(string(b), "'", "''") + "'"
}

// queryBody is the shared shape for Query and Exec.
type queryBody struct {
	SQL  string `json:"sql"`
	Args []any  `json:"args,omitempty"`
	// Database overrides the connection's bound DB. Required for PG
	// cross-catalog browsing; optional for MySQL where the same
	// connection can SELECT across schemas freely.
	Database string `json:"database,omitempty"`
	// Limit caps the SELECT row count (Query only). 0 = use server default.
	Limit int `json:"limit,omitempty"`
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
	sqlText, err := h.Svc.BuildRowsSQL(c.Request.Context(), nodeID, claims.UserID, database, schema, table, orderBy, orderDir, limit, offset)
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

// isReadOnlySQL classifies a statement as read-only. This is a conservative
// guard, not a full SQL parser: obvious writes and common read-looking
// side-effect paths are rejected so callers use the write/approval endpoint.
func isReadOnlySQL(s string) bool {
	s = expandMySQLExecutableComments(s)
	s = stripLeadingSQLComments(s)
	if s == "" || hasMultipleStatements(s) {
		return false
	}
	upper := normaliseSQLForKeywordScan(s)
	head := sqlHead(s)
	if head == "" {
		return false
	}
	if containsAnyKeyword(upper, []string{"PG_TERMINATE_BACKEND", "PG_CANCEL_BACKEND", "PG_RELOAD_CONF"}) {
		return false
	}
	if containsKeywordSequence(upper, "INTO", "OUTFILE") || containsKeywordSequence(upper, "INTO", "DUMPFILE") {
		return false
	}
	switch head {
	case "SELECT":
		return !containsKeyword(upper, "INTO")
	case "WITH":
		return !containsAnyKeyword(upper, []string{"INSERT", "UPDATE", "DELETE", "MERGE", "CREATE", "ALTER", "DROP", "TRUNCATE", "CALL", "DO", "COPY", "GRANT", "REVOKE", "INTO"})
	case "EXPLAIN":
		return !containsKeyword(upper, "ANALYZE")
	case "SHOW", "DESCRIBE", "DESC", "VALUES":
		return true
	default:
		return false
	}
}

func stripLeadingSQLComments(s string) string {
	for {
		s = strings.TrimLeftFunc(s, func(r rune) bool { return r == ' ' || r == '\t' || r == '\n' || r == '\r' })
		if strings.HasPrefix(s, "--") {
			if idx := strings.IndexByte(s, '\n'); idx >= 0 {
				s = s[idx+1:]
				continue
			}
			return ""
		}
		if strings.HasPrefix(s, "/*") {
			if idx := strings.Index(s, "*/"); idx >= 0 {
				s = s[idx+2:]
				continue
			}
			return ""
		}
		return strings.TrimSpace(s)
	}
}

func sqlHead(s string) string {
	upper := strings.ToUpper(stripLeadingSQLComments(expandMySQLExecutableComments(s)))
	for _, head := range []string{"SELECT", "WITH", "EXPLAIN", "SHOW", "DESCRIBE", "DESC", "VALUES"} {
		if strings.HasPrefix(upper, head) && hasHeadBoundary(upper, head) {
			return head
		}
	}
	return ""
}

func expandMySQLExecutableComments(s string) string {
	var b strings.Builder
	b.Grow(len(s))
	for i := 0; i < len(s); i++ {
		if i+2 < len(s) && s[i] == '/' && s[i+1] == '*' && s[i+2] == '!' {
			end := strings.Index(s[i+3:], "*/")
			if end < 0 {
				b.WriteString(s[i:])
				break
			}
			inner := s[i+3 : i+3+end]
			inner = strings.TrimLeftFunc(inner, func(r rune) bool { return r >= '0' && r <= '9' })
			b.WriteByte(' ')
			b.WriteString(inner)
			b.WriteByte(' ')
			i += 3 + end + 1
			continue
		}
		b.WriteByte(s[i])
	}
	return b.String()
}

func hasHeadBoundary(upper, head string) bool {
	if len(upper) == len(head) {
		return true
	}
	next := upper[len(head)]
	return next == ' ' || next == '\t' || next == '\n' || next == '\r' || next == '(' || next == ';'
}

func hasMultipleStatements(s string) bool {
	inSingle, inDouble, inBacktick := false, false, false
	for i := 0; i < len(s); i++ {
		ch := s[i]
		if inSingle {
			if ch == '\'' {
				if i+1 < len(s) && s[i+1] == '\'' {
					i++
					continue
				}
				inSingle = false
			}
			continue
		}
		if inDouble {
			if ch == '"' {
				inDouble = false
			}
			continue
		}
		if inBacktick {
			if ch == '`' {
				inBacktick = false
			}
			continue
		}
		if ch == '-' && i+1 < len(s) && s[i+1] == '-' {
			if idx := strings.IndexByte(s[i+2:], '\n'); idx >= 0 {
				i += idx + 2
				continue
			}
			return false
		}
		if ch == '/' && i+1 < len(s) && s[i+1] == '*' {
			if idx := strings.Index(s[i+2:], "*/"); idx >= 0 {
				i += idx + 3
				continue
			}
			return false
		}
		switch ch {
		case '\'':
			inSingle = true
		case '"':
			inDouble = true
		case '`':
			inBacktick = true
		case ';':
			return stripLeadingSQLComments(s[i+1:]) != ""
		}
	}
	return false
}

func normaliseSQLForKeywordScan(s string) string {
	var b strings.Builder
	b.Grow(len(s))
	inSingle, inDouble, inBacktick := false, false, false
	for i := 0; i < len(s); i++ {
		ch := s[i]
		if inSingle {
			b.WriteByte(' ')
			if ch == '\'' {
				if i+1 < len(s) && s[i+1] == '\'' {
					i++
					b.WriteByte(' ')
					continue
				}
				inSingle = false
			}
			continue
		}
		if inDouble {
			b.WriteByte(' ')
			if ch == '"' {
				if i+1 < len(s) && s[i+1] == '"' {
					i++
					b.WriteByte(' ')
					continue
				}
				inDouble = false
			}
			continue
		}
		if inBacktick {
			b.WriteByte(' ')
			if ch == '`' {
				if i+1 < len(s) && s[i+1] == '`' {
					i++
					b.WriteByte(' ')
					continue
				}
				inBacktick = false
			}
			continue
		}
		if ch == '-' && i+1 < len(s) && s[i+1] == '-' {
			b.WriteString("  ")
			i++
			for i+1 < len(s) && s[i+1] != '\n' {
				i++
				b.WriteByte(' ')
			}
			continue
		}
		if ch == '/' && i+1 < len(s) && s[i+1] == '*' {
			b.WriteString("  ")
			i++
			for i+1 < len(s) {
				if s[i] == '*' && s[i+1] == '/' {
					b.WriteString("  ")
					i++
					break
				}
				i++
				b.WriteByte(' ')
			}
			continue
		}
		switch ch {
		case '\'':
			inSingle = true
			b.WriteByte(' ')
		case '"':
			inDouble = true
			b.WriteByte(' ')
		case '`':
			inBacktick = true
			b.WriteByte(' ')
		default:
			b.WriteByte(byte(strings.ToUpper(string(ch))[0]))
		}
	}
	return b.String()
}

func containsAnyKeyword(s string, keywords []string) bool {
	for _, keyword := range keywords {
		if containsKeyword(s, keyword) {
			return true
		}
	}
	return false
}

func containsKeywordSequence(s, first, second string) bool {
	idx := keywordIndex(s, first)
	if idx < 0 {
		return false
	}
	return containsKeyword(s[idx+len(first):], second)
}

func containsKeyword(s, keyword string) bool {
	return keywordIndex(s, keyword) >= 0
}

func keywordIndex(s, keyword string) int {
	for start := 0; ; {
		idx := strings.Index(s[start:], keyword)
		if idx < 0 {
			return -1
		}
		idx += start
		beforeOK := idx == 0 || !isSQLIdent(s[idx-1])
		after := idx + len(keyword)
		afterOK := after >= len(s) || !isSQLIdent(s[after])
		if beforeOK && afterOK {
			return idx
		}
		start = idx + len(keyword)
	}
}

func isSQLIdent(ch byte) bool {
	return (ch >= 'A' && ch <= 'Z') || (ch >= '0' && ch <= '9') || ch == '_'
}
