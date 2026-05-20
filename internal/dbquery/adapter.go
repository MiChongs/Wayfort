package dbquery

import (
	"fmt"
	"strings"

	"github.com/michongs/jumpserver-anonymous/internal/model"
)

type DatabaseScope string

const (
	DatabaseScopeCatalog DatabaseScope = "catalog"
	DatabaseScopeSchema  DatabaseScope = "schema"
)

type Capabilities struct {
	ListDatabases  bool          `json:"list_databases"`
	Schemas        bool          `json:"schemas"`
	RowEdits       bool          `json:"row_edits"`
	Explain        bool          `json:"explain"`
	ExplainAnalyze bool          `json:"explain_analyze"`
	Processes      bool          `json:"processes"`
	KillProcess    bool          `json:"kill_process"`
	TableDDL       bool          `json:"table_ddl"`
	TableStats     bool          `json:"table_stats"`
	ForeignKeys    bool          `json:"foreign_keys"`
	Export         bool          `json:"export"`
	LastInsertID   bool          `json:"last_insert_id"`
	DatabaseScope  DatabaseScope `json:"database_scope"`
}

type Dialect interface {
	QuoteIdent(string) string
	Placeholder(int) string
	BuildRowsSQL(schema, table, orderBy, orderDir string, limit, offset int) (string, error)
}

type Adapter interface {
	Protocol() model.NodeProtocol
	Capabilities() Capabilities
	Dialect() Dialect
}

type Registry struct {
	adapters map[model.NodeProtocol]Adapter
}

func NewRegistry(adapters ...Adapter) *Registry {
	r := &Registry{adapters: map[model.NodeProtocol]Adapter{}}
	for _, adapter := range adapters {
		r.Register(adapter)
	}
	return r
}

func DefaultRegistry() *Registry {
	return NewRegistry(mysqlAdapter{}, postgresAdapter{})
}

func (r *Registry) Register(adapter Adapter) {
	if r == nil || adapter == nil {
		return
	}
	if r.adapters == nil {
		r.adapters = map[model.NodeProtocol]Adapter{}
	}
	r.adapters[adapter.Protocol()] = adapter
}

func (r *Registry) Get(protocol model.NodeProtocol) (Adapter, bool) {
	if r == nil || r.adapters == nil {
		return nil, false
	}
	adapter, ok := r.adapters[protocol]
	return adapter, ok
}

func buildRowsSelectSQL(d Dialect, schema, table, orderBy, orderDir string, limit, offset int) (string, error) {
	if d == nil {
		return "", fmt.Errorf("dbquery: dialect not configured")
	}
	if limit < 0 || offset < 0 {
		return "", fmt.Errorf("dbquery: limit and offset must be non-negative")
	}
	orderDir = strings.ToUpper(strings.TrimSpace(orderDir))
	if orderDir != "" && orderDir != "ASC" && orderDir != "DESC" {
		return "", fmt.Errorf("dbquery: order direction must be ASC or DESC")
	}
	q := "SELECT * FROM " + d.QuoteIdent(schema) + "." + d.QuoteIdent(table)
	if orderBy != "" {
		q += " ORDER BY " + d.QuoteIdent(orderBy)
		if orderDir != "" {
			q += " " + orderDir
		}
	}
	q += fmt.Sprintf(" LIMIT %d OFFSET %d", limit, offset)
	return q, nil
}
