"use client";

import { useMemo } from "react";

export function JsonPreview({ value }: { value: unknown }) {
  const parsed = useMemo(() => {
    if (typeof value === "string") {
      try { return JSON.parse(value); } catch { return value; }
    }
    return value;
  }, [value]);
  return <pre className="text-xs">{JSON.stringify(parsed, null, 2)}</pre>;
}
