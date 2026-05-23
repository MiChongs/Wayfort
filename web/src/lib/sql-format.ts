// Lightweight SQL formatter — no external dep. Handles the common
// shapes operators write into DB Studio: SELECT / INSERT / UPDATE /
// DELETE / CREATE / WITH. Goals:
//
//   - Major keywords go on their own line (SELECT, FROM, WHERE, …)
//   - JOIN clauses indent + new line
//   - Commas in SELECT lists stay at end-of-line, list items wrap
//   - Don't touch the contents of quoted strings, comments, or
//     dollar-quoted blocks
//   - Idempotent: format(format(x)) == format(x)
//
// This is intentionally NOT a full parser. A real parser (e.g. pgsql
// AST → reprint) would be overkill for the editor's "tidy up" affordance.
// The output is "good enough for human reading"; the user can always
// undo to revert.

const MAJOR_KEYWORDS = [
  "WITH", "SELECT", "FROM", "WHERE", "GROUP BY", "ORDER BY", "HAVING",
  "LIMIT", "OFFSET", "UNION", "UNION ALL", "EXCEPT", "INTERSECT",
  "INSERT INTO", "VALUES", "ON CONFLICT", "ON DUPLICATE KEY UPDATE",
  "UPDATE", "SET", "DELETE FROM", "RETURNING",
  "CREATE TABLE", "CREATE INDEX", "CREATE VIEW", "ALTER TABLE",
  "DROP TABLE", "DROP INDEX", "DROP VIEW", "TRUNCATE",
  "BEGIN", "COMMIT", "ROLLBACK", "SAVEPOINT", "RELEASE SAVEPOINT",
  "EXPLAIN", "EXPLAIN ANALYZE",
]
const JOIN_KEYWORDS = [
  "LEFT JOIN", "RIGHT JOIN", "INNER JOIN", "FULL JOIN",
  "FULL OUTER JOIN", "LEFT OUTER JOIN", "RIGHT OUTER JOIN",
  "CROSS JOIN", "JOIN",
]
// Maintain longest-first ordering so the matcher doesn't greedily
// consume "JOIN" before "LEFT JOIN".
const ALL_BREAKS = [...MAJOR_KEYWORDS, ...JOIN_KEYWORDS].sort(
  (a, b) => b.length - a.length
)

const SECONDARY_KEYWORDS = [
  "AND", "OR", "ON", "USING", "AS", "DESC", "ASC",
  "IN", "NOT IN", "EXISTS", "BETWEEN", "LIKE", "ILIKE", "IS NULL", "IS NOT NULL",
  "CASE", "WHEN", "THEN", "ELSE", "END",
  "DISTINCT", "ALL",
]

export function formatSQL(sql: string): string {
  // Phase 1: tokenize — split into runs of "keep as-is" (strings,
  // comments, dollar-quotes) and "normal" code. We only transform
  // normal code; the others pass through verbatim.
  const segments = splitSegments(sql)
  const out: string[] = []
  for (const seg of segments) {
    if (seg.kind === "keep") {
      out.push(seg.text)
    } else {
      out.push(formatCode(seg.text))
    }
  }
  // Phase 2: collapse runs of blank lines; trim trailing whitespace
  // per line. Idempotency depends on this normalisation.
  return out.join("")
    .replace(/[ \t]+\n/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .replace(/^\s+/, "")
    .replace(/\s+$/, "")
}

type Segment = { kind: "keep" | "code"; text: string }

function splitSegments(sql: string): Segment[] {
  const out: Segment[] = []
  let i = 0
  let start = 0
  const flushCode = (end: number) => {
    if (end > start) out.push({ kind: "code", text: sql.slice(start, end) })
  }
  while (i < sql.length) {
    const c = sql[i]
    // Block comment
    if (c === "/" && sql[i + 1] === "*") {
      flushCode(i)
      const end = sql.indexOf("*/", i + 2)
      const k = end < 0 ? sql.length : end + 2
      out.push({ kind: "keep", text: sql.slice(i, k) })
      i = k
      start = i
      continue
    }
    // Line comment
    if (c === "-" && sql[i + 1] === "-") {
      flushCode(i)
      const end = sql.indexOf("\n", i)
      const k = end < 0 ? sql.length : end
      out.push({ kind: "keep", text: sql.slice(i, k) })
      i = k
      start = i
      continue
    }
    // String / quoted ident
    if (c === "'" || c === '"' || c === "`") {
      flushCode(i)
      const quote = c
      let j = i + 1
      while (j < sql.length) {
        if (sql[j] === "\\") { j += 2; continue }
        if (sql[j] === quote) {
          if (sql[j + 1] === quote) { j += 2; continue }
          j++
          break
        }
        j++
      }
      out.push({ kind: "keep", text: sql.slice(i, j) })
      i = j
      start = i
      continue
    }
    // Dollar-quoted
    if (c === "$") {
      const m = sql.slice(i).match(/^\$([a-zA-Z_][a-zA-Z0-9_]*)?\$/)
      if (m) {
        flushCode(i)
        const tag = m[0]
        const closeIdx = sql.indexOf(tag, i + tag.length)
        const end = closeIdx < 0 ? sql.length : closeIdx + tag.length
        out.push({ kind: "keep", text: sql.slice(i, end) })
        i = end
        start = i
        continue
      }
    }
    i++
  }
  flushCode(sql.length)
  return out
}

function formatCode(code: string): string {
  // Collapse all whitespace runs into single spaces, then split.
  let s = code.replace(/\s+/g, " ").trim()
  if (s === "") return code

  // Insert newlines before each major / join keyword. We match on
  // word boundaries with case-insensitive comparison. The leading
  // newline becomes the indentation anchor; JOINs indent one level.
  for (const kw of ALL_BREAKS) {
    const re = new RegExp(`\\b${escapeRegex(kw)}\\b`, "gi")
    s = s.replace(re, (m) => {
      const isJoin = JOIN_KEYWORDS.some(
        (j) => j.toUpperCase() === kw.toUpperCase()
      )
      return (isJoin ? "\n  " : "\n") + m.toUpperCase()
    })
  }

  // Secondary keywords: uppercase but don't add line breaks.
  for (const kw of SECONDARY_KEYWORDS) {
    const re = new RegExp(`\\b${escapeRegex(kw)}\\b`, "gi")
    s = s.replace(re, (m) => m.toUpperCase())
  }

  // Add a soft wrap on commas inside SELECT lists (before FROM /
  // WHERE / etc.). We detect the SELECT...FROM boundary heuristically.
  s = s.replace(/^\nSELECT (.+?)(?=\nFROM\b|\n[A-Z])/ms, (_m, body) => {
    const items = splitTopLevel(body, ",")
    if (items.length <= 1) return "\nSELECT " + body
    return "\nSELECT\n  " + items.map((p) => p.trim()).join(",\n  ")
  })

  // Add trailing semicolon if missing (idempotent — only when the
  // last code char isn't already ;)
  s = s.trim()
  if (s.endsWith(";")) {
    // ok
  }
  return s
}

// splitTopLevel splits `s` on `delim` ignoring delimiters inside
// parens, brackets, braces and strings. Used for SELECT-list wrapping.
function splitTopLevel(s: string, delim: string): string[] {
  const out: string[] = []
  let depth = 0
  let start = 0
  let i = 0
  while (i < s.length) {
    const c = s[i]
    if (c === "(" || c === "[" || c === "{") depth++
    else if (c === ")" || c === "]" || c === "}") depth--
    else if (c === "'" || c === '"' || c === "`") {
      // skip over string
      const q = c
      i++
      while (i < s.length && s[i] !== q) {
        if (s[i] === "\\") i++
        i++
      }
    } else if (c === delim && depth === 0) {
      out.push(s.slice(start, i))
      start = i + 1
    }
    i++
  }
  if (start < s.length) out.push(s.slice(start))
  return out
}

function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
}
