package api

import "testing"

func TestIsReadOnlySQL(t *testing.T) {
	t.Parallel()
	tests := []struct {
		name string
		sql  string
		want bool
	}{
		{name: "select", sql: "SELECT 1", want: true},
		{name: "line comment select", sql: "-- comment\nSELECT 1", want: true},
		{name: "block comment select", sql: "/* comment */ SELECT 1", want: true},
		{name: "show", sql: "SHOW TABLES", want: true},
		{name: "describe", sql: "DESCRIBE users", want: true},
		{name: "values", sql: "VALUES (1)", want: true},
		{name: "insert", sql: "INSERT INTO t VALUES (1)", want: false},
		{name: "update", sql: "UPDATE t SET a=1", want: false},
		{name: "delete", sql: "DELETE FROM t", want: false},
		{name: "multi statement write", sql: "SELECT 1; DELETE FROM t", want: false},
		{name: "trailing semicolon", sql: "SELECT 1;", want: true},
		{name: "writable cte", sql: "WITH deleted AS (DELETE FROM t RETURNING *) SELECT * FROM deleted", want: false},
		{name: "cte select into", sql: "WITH q AS (SELECT 1 AS id) SELECT * INTO new_table FROM q", want: false},
		{name: "explain analyze", sql: "EXPLAIN ANALYZE SELECT 1", want: false},
		{name: "plain explain", sql: "EXPLAIN SELECT 1", want: true},
		{name: "postgres select into", sql: "SELECT * INTO new_table FROM users", want: false},
		{name: "mysql select into outfile", sql: "SELECT * INTO OUTFILE '/tmp/x' FROM users", want: false},
		{name: "mysql executable comment into outfile", sql: "SELECT 1 /*! INTO OUTFILE '/tmp/x' */", want: false},
		{name: "mysql executable comment safe select", sql: "/*! SELECT 1 */", want: true},
		{name: "mysql executable comment write", sql: "/*! DELETE FROM t */", want: false},
		{name: "mysql select into dumpfile", sql: "SELECT * INTO DUMPFILE '/tmp/x' FROM users", want: false},
		{name: "side effect function", sql: "SELECT pg_terminate_backend(1)", want: false},
		{name: "forbidden keyword in string", sql: "SELECT 'INTO UPDATE DELETE'", want: true},
		{name: "forbidden keyword in quoted identifier", sql: `SELECT "into" FROM "update"`, want: true},
		{name: "forbidden keyword in mysql quoted identifier", sql: "SELECT `into` FROM `update`", want: true},
		{name: "cte keyword in string", sql: "WITH q AS (SELECT 'update') SELECT * FROM q", want: true},
		{name: "identifier containing insert", sql: "SELECT insert_count FROM stats", want: true},
		{name: "semicolon in string", sql: "SELECT ';'", want: true},
	}
	for _, tt := range tests {
		tt := tt
		t.Run(tt.name, func(t *testing.T) {
			t.Parallel()
			if got := isReadOnlySQL(tt.sql); got != tt.want {
				t.Fatalf("isReadOnlySQL(%q) = %v, want %v", tt.sql, got, tt.want)
			}
		})
	}
}

func TestSQLHead(t *testing.T) {
	t.Parallel()
	if got := sqlHead("/* comment */ EXPLAIN SELECT 1"); got != "EXPLAIN" {
		t.Fatalf("sqlHead() = %q, want EXPLAIN", got)
	}
}
