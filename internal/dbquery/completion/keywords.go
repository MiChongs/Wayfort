package completion

// Keywords returns the bundled SQL reserved word list for an engine family.
// Lowercased family ids ("mysql" / "postgresql" / "oracle"); unknown returns nil.
func Keywords(family string) []string {
	switch family {
	case "mysql":
		return mysqlKeywords
	case "postgresql":
		return postgresKeywords
	case "oracle":
		return oracleKeywords
	default:
		return nil
	}
}

var commonSQL = []string{
	"SELECT", "FROM", "WHERE", "GROUP", "BY", "ORDER", "HAVING", "LIMIT", "OFFSET",
	"INSERT", "INTO", "VALUES", "UPDATE", "SET", "DELETE", "JOIN", "INNER", "LEFT",
	"RIGHT", "FULL", "OUTER", "ON", "AS", "AND", "OR", "NOT", "NULL", "IS", "IN",
	"BETWEEN", "LIKE", "EXISTS", "UNION", "ALL", "DISTINCT", "CASE", "WHEN", "THEN",
	"ELSE", "END", "WITH", "CREATE", "TABLE", "VIEW", "INDEX", "DROP", "ALTER", "ADD",
	"COLUMN", "PRIMARY", "KEY", "FOREIGN", "REFERENCES", "CONSTRAINT", "DEFAULT",
	"BEGIN", "COMMIT", "ROLLBACK", "TRANSACTION", "GRANT", "REVOKE", "TRUE", "FALSE",
}

var mysqlKeywords = append([]string{
	"DESCRIBE", "EXPLAIN", "SHOW", "DATABASES", "TABLES", "USE", "AUTO_INCREMENT",
	"UNSIGNED", "ZEROFILL", "BINARY", "VARBINARY", "TINYINT", "SMALLINT", "MEDIUMINT",
	"BIGINT", "FLOAT", "DOUBLE", "DECIMAL", "DATE", "DATETIME", "TIMESTAMP",
	"VARCHAR", "TEXT", "LONGTEXT", "BLOB", "LONGBLOB", "JSON", "ENGINE", "CHARSET",
}, commonSQL...)

var postgresKeywords = append([]string{
	"RETURNING", "ILIKE", "USING", "WINDOW", "PARTITION", "OVER", "ROWS", "RANGE",
	"GROUPING", "SETS", "ROLLUP", "CUBE", "LATERAL", "ARRAY", "JSONB", "INTERVAL",
	"SERIAL", "BIGSERIAL", "BOOLEAN", "TEXT", "VARCHAR", "INTEGER", "BIGINT",
	"NUMERIC", "TIMESTAMP", "TIMESTAMPTZ", "UUID", "BYTEA", "EXTENSION", "SCHEMA",
}, commonSQL...)

var oracleKeywords = append([]string{
	"VARCHAR2", "NUMBER", "CLOB", "BLOB", "MERGE", "USING", "ROWNUM", "SYSDATE",
	"DUAL", "NOCYCLE", "MINUS", "INTERSECT", "PLAN_TABLE",
}, commonSQL...)
