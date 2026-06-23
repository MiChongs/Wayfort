"use client";

import type { ReactNode } from "react";

interface Props {
  children?: ReactNode;
  className?: string;
}

/**
 * Phase 1 stub. React Flow dependency is introduced in sub-project E/F plan.
 * Provides the shared API surface today so callers compile.
 */
export function ReactFlowCanvas({ children, className }: Props) {
  return (
    <div
      className={className}
      style={{ width: "100%", height: "100%", position: "relative", border: "1px dashed var(--muted)" }}
      data-testid="react-flow-canvas-stub"
    >
      <div style={{ padding: 12, color: "var(--muted-foreground)" }}>
        Canvas placeholder — wired by sub-project E (builder) / F (modeler).
      </div>
      {children}
    </div>
  );
}
