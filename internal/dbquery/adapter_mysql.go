package dbquery

import (
	"strings"

	"github.com/michongs/jumpserver-anonymous/internal/model"
)

type mysqlAdapter struct{}

func (mysqlAdapter) Protocol() model.NodeProtocol { return model.NodeProtoMySQL }

func (mysqlAdapter) Capabilities() Capabilities {
	return Capabilities{
		ListDatabases:  true,
		Schemas:        true,
		RowEdits:       true,
		Explain:        true,
		ExplainAnalyze: true,
		Processes:      true,
		KillProcess:    true,
		TableDDL:       true,
		TableStats:     true,
		ForeignKeys:    true,
		Export:         true,
		LastInsertID:   true,
		DatabaseScope:  DatabaseScopeSchema,
	}
}

func (mysqlAdapter) Dialect() Dialect { return mysqlDialect{} }

type mysqlDialect struct{}

func (mysqlDialect) QuoteIdent(s string) string {
	return "`" + strings.ReplaceAll(s, "`", "``") + "`"
}

func (mysqlDialect) Placeholder(int) string { return "?" }

func (d mysqlDialect) BuildRowsSQL(schema, table, orderBy, orderDir string, limit, offset int) (string, error) {
	return buildRowsSelectSQL(d, schema, table, orderBy, orderDir, limit, offset)
}
