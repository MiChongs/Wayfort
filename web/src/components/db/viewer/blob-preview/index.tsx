"use client";

import { Sheet, SheetContent, SheetHeader, SheetTitle } from "@/components/ui/sheet";
import { ImagePreview } from "./image";
import { JsonPreview } from "./json";
import { GeoPreview } from "./geo";
import { HexPreview } from "./hex";

interface Props {
  open: boolean;
  onClose: () => void;
  value: unknown;
  columnName: string;
  dataType: string;
}

// BlobPreview — Phase 2C.3 cell preview router. Auto-detects the best
// renderer from the column's declared `dataType` plus the value's magic
// bytes / shape, and renders inside a right-side Sheet. READ-ONLY in
// 2C (JSON edit-back lands in a later sub-project).
export function BlobPreview({ open, onClose, value, columnName, dataType }: Props) {
  const view = detect(value, dataType);
  return (
    <Sheet open={open} onOpenChange={(o) => !o && onClose()}>
      <SheetContent className="w-[640px] sm:max-w-[640px]">
        <SheetHeader>
          <SheetTitle>{columnName} <span className="text-xs text-muted-foreground">({view})</span></SheetTitle>
        </SheetHeader>
        <div className="mt-2 overflow-auto" style={{ maxHeight: "70vh" }}>
          {view === "image" && <ImagePreview value={value} />}
          {view === "json" && <JsonPreview value={value} />}
          {view === "geo" && <GeoPreview value={value} />}
          {view === "hex" && <HexPreview value={value} />}
        </div>
      </SheetContent>
    </Sheet>
  );
}

function detect(value: unknown, dataType: string): "image" | "json" | "geo" | "hex" {
  const dt = dataType.toLowerCase();
  if (dt.includes("geometry") || dt.includes("geography") || dt === "point" || dt === "polygon") return "geo";
  if (dt.includes("json")) return "json";
  if (typeof value === "string") {
    // Detect base64 image magic
    const b = value.slice(0, 12).toLowerCase();
    if (b.startsWith("iv") || b.startsWith("/9j/") || b.startsWith("r0lgo") || b.startsWith("uklgr")) return "image";
    // GeoJSON / WKT
    if (value.trim().startsWith('{"type":"') && value.includes('"coordinates"')) return "geo";
    if (/^(POINT|POLYGON|LINESTRING|MULTI)/i.test(value.trim())) return "geo";
    // JSON
    const trimmed = value.trim();
    if ((trimmed.startsWith("{") && trimmed.endsWith("}")) || (trimmed.startsWith("[") && trimmed.endsWith("]"))) {
      try { JSON.parse(trimmed); return "json"; } catch { /* fall through */ }
    }
  }
  if (dt.includes("blob") || dt.includes("binary") || dt === "bytea") return "hex";
  return "hex";
}
