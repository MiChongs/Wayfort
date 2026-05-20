package dbquery

import (
	"fmt"
	"strings"

	"github.com/michongs/jumpserver-anonymous/internal/model"
)

type postgresAdapter struct{}

func (postgresAdapter) Protocol() model.NodeProtocol { return model.NodeProtoPostgres }

func (postgresAdapter) Capabilities() Capabilities {
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
		LastInsertID:   false,
		DatabaseScope:  DatabaseScopeCatalog,
	}
}

func (postgresAdapter) Dialect() Dialect { return postgresDialect{} }

type postgresDialect struct{}

func (postgresDialect) QuoteIdent(s string) string {
	return `"` + strings.ReplaceAll(s, `"`, `""`) + `"`
}

func (postgresDialect) Placeholder(n int) string { return fmt.Sprintf("$%d", n) }

func (d postgresDialect) BuildRowsSQL(schema, table, orderBy, orderDir string, limit, offset int) (string, error) {
	return buildRowsSelectSQL(d, schema, table, orderBy, orderDir, limit, offset)
}
