"use client";

import { DiffEditor, Editor } from "@monaco-editor/react";

interface Props {
  sql: string;
  /** Optional "before" SQL — triggers side-by-side diff view. */
  diff?: string;
  dialect?: "mysql" | "postgresql" | "oracle";
  height?: string;
}

/** Read-only Monaco wrapper for DDL preview + side-by-side diff. Used by
 *  the object designer (sub-project B) and ER forward-engineering preview
 *  (sub-project F). Phase 1 ships the contract; concrete callers land in
 *  the sub-project plans. */
export function DDLRenderer({ sql, diff, dialect = "mysql", height = "320px" }: Props) {
  void dialect; // dialect-aware syntax highlights are a sub-project B follow-up
  if (diff !== undefined) {
    return (
      <DiffEditor
        height={height}
        language="sql"
        original={diff}
        modified={sql}
        options={{ readOnly: true, renderSideBySide: true, minimap: { enabled: false } }}
      />
    );
  }
  return (
    <Editor
      height={height}
      language="sql"
      value={sql}
      options={{ readOnly: true, minimap: { enabled: false } }}
    />
  );
}
