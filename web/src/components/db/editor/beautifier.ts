// Phase 2A.4 — SQL beautifier backed by sql-formatter.
//
// The editor already ships a dependency-free keyword formatter
// (`@/lib/sql-format`) used by the 格式化 button; it reflows major
// keywords onto their own lines but is dialect-blind. This module
// wraps sql-formatter, a real tokenizer that understands MySQL /
// PostgreSQL / PL-SQL (Dameng + Oracle) / T-SQL syntax, so the 美化
// affordance + Shift+Alt+F shortcut produce idiomatic, deeply
// indented output. Kept as a thin façade so the editor never touches
// the library's option surface directly.

import { format, type SqlLanguage } from "sql-formatter";

/**
 * Map a DBCapabilities.vendor_label to a sql-formatter SqlLanguage.
 *
 * sql-formatter has no dedicated "oracle" dialect — PL/SQL (plsql)
 * covers both Oracle and Dameng (which is wire-compatible with
 * Oracle). T-SQL covers SQL Server / MSSQL.
 */
function mapDialect(vendorLabel: string): SqlLanguage {
  const v = (vendorLabel || "").toLowerCase();
  if (v.includes("postgres") || v === "pg") return "postgresql";
  if (v.includes("dameng") || v.includes("oracle")) return "plsql";
  if (v.includes("sql server") || v.includes("mssql") || v === "tsql") {
    return "transactsql";
  }
  return "mysql";
}

/**
 * Pretty-print SQL with project defaults: uppercase keywords, 2-space
 * indent (spaces, never tabs), and a blank line between consecutive
 * statements. Returns the original string verbatim if sql-formatter
 * raises (e.g. unrecoverable tokenize error) so the editor never
 * silently wipes the buffer — callers surface the message via toast.
 */
export function formatSQL(sql: string, vendorLabel: string): string {
  return format(sql, {
    language: mapDialect(vendorLabel),
    keywordCase: "upper",
    tabWidth: 2,
    useTabs: false,
    linesBetweenQueries: 2,
  });
}
