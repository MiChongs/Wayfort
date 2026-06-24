import type * as monaco from "monaco-editor";
import type { SchemaSnapshot } from "@/components/db/shared/schema-cache";

/**
 * registerSchemaCompletion attaches a Monaco CompletionItemProvider that
 * emits schema/table/column candidates from the supplied snapshot. Returns
 * an IDisposable the caller MUST dispose on unmount (or when the snapshot
 * changes — `useEffect` cleanup).
 */
export function registerSchemaCompletion(
  monacoApi: typeof monaco,
  snapshot: SchemaSnapshot,
  keywords: string[],
): monaco.IDisposable {
  return monacoApi.languages.registerCompletionItemProvider("sql", {
    triggerCharacters: [".", " "],
    provideCompletionItems(model, position) {
      const word = model.getWordUntilPosition(position);
      const range: monaco.IRange = {
        startLineNumber: position.lineNumber,
        endLineNumber: position.lineNumber,
        startColumn: word.startColumn,
        endColumn: word.endColumn,
      };

      const lineUpToCursor = model
        .getValueInRange({
          startLineNumber: position.lineNumber,
          startColumn: 1,
          endLineNumber: position.lineNumber,
          endColumn: position.column,
        })
        .toUpperCase();

      // `a.|` → resolve alias / table → columns
      const dotMatch = lineUpToCursor.match(/(\w+)\.$/);
      if (dotMatch) {
        const target = dotMatch[1].toLowerCase();
        const aliasMap = collectAliases(model.getValue());
        const tableFqn = aliasMap.get(target) ?? findTableByName(snapshot, target);
        if (tableFqn) {
          return { suggestions: columnSuggestions(monacoApi, snapshot, tableFqn, range) };
        }
        // fallthrough: maybe a schema prefix
        return { suggestions: tablesInSchema(monacoApi, snapshot, target, range) };
      }

      // post-`FROM ` / `JOIN ` → tables
      if (/\b(FROM|JOIN|UPDATE|INTO)\s+$/.test(lineUpToCursor)) {
        return { suggestions: allTables(monacoApi, snapshot, range) };
      }

      // default: tables + keywords + functions
      return {
        suggestions: [
          ...allTables(monacoApi, snapshot, range),
          ...keywordSuggestions(monacoApi, keywords, range),
          ...functionSuggestions(monacoApi, snapshot, range),
        ],
      };
    },
  });
}

function columnSuggestions(
  m: typeof monaco,
  snap: SchemaSnapshot,
  tableFqn: string,
  range: monaco.IRange,
): monaco.languages.CompletionItem[] {
  const [schema, name] = tableFqn.split(".");
  const t = snap.tables.find((x) => x.schema === schema && x.name === name);
  if (!t) return [];
  return t.columns.map((c) => ({
    label: c.name,
    kind: m.languages.CompletionItemKind.Field,
    insertText: c.name,
    detail: `${c.dataType}${c.nullable ? " NULL" : " NOT NULL"}`,
    range,
  }));
}

function tablesInSchema(
  m: typeof monaco,
  snap: SchemaSnapshot,
  schema: string,
  range: monaco.IRange,
): monaco.languages.CompletionItem[] {
  return snap.tables
    .filter((t) => t.schema.toLowerCase() === schema)
    .map((t) => ({
      label: t.name,
      kind: m.languages.CompletionItemKind.Struct,
      insertText: t.name,
      detail: t.kind,
      range,
    }));
}

function allTables(
  m: typeof monaco,
  snap: SchemaSnapshot,
  range: monaco.IRange,
): monaco.languages.CompletionItem[] {
  return snap.tables.map((t) => ({
    label: `${t.schema}.${t.name}`,
    kind: m.languages.CompletionItemKind.Struct,
    insertText: `${t.schema}.${t.name}`,
    detail: t.kind,
    range,
  }));
}

function keywordSuggestions(
  m: typeof monaco,
  keywords: string[],
  range: monaco.IRange,
): monaco.languages.CompletionItem[] {
  return keywords.map((k) => ({
    label: k,
    kind: m.languages.CompletionItemKind.Keyword,
    insertText: k,
    range,
  }));
}

function functionSuggestions(
  m: typeof monaco,
  snap: SchemaSnapshot,
  range: monaco.IRange,
): monaco.languages.CompletionItem[] {
  return snap.functions.map((f) => ({
    label: `${f.schema}.${f.name}`,
    kind: m.languages.CompletionItemKind.Function,
    insertText: `${f.schema}.${f.name}()`,
    detail: `→ ${f.returnType}`,
    range,
  }));
}

/** Naive alias collector: looks for `FROM table alias` / `JOIN table alias`
 *  in the entire document. Aliases are case-insensitive. */
function collectAliases(sql: string): Map<string, string> {
  const out = new Map<string, string>();
  const re = /\b(?:FROM|JOIN)\s+([\w.]+)(?:\s+(?:AS\s+)?(\w+))?/gi;
  let m: RegExpExecArray | null;
  while ((m = re.exec(sql)) !== null) {
    const fqn = m[1];
    const alias = m[2] ?? m[1].split(".").pop()!;
    out.set(alias.toLowerCase(), fqn.includes(".") ? fqn : `public.${fqn}`);
  }
  return out;
}

function findTableByName(snap: SchemaSnapshot, name: string): string | undefined {
  const lower = name.toLowerCase();
  const t = snap.tables.find((x) => x.name.toLowerCase() === lower);
  return t ? `${t.schema}.${t.name}` : undefined;
}
