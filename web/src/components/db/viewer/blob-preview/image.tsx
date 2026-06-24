"use client";

export function ImagePreview({ value }: { value: unknown }) {
  if (typeof value !== "string") return <div className="text-muted-foreground">不支持的图片格式</div>;
  // Detect MIME from magic bytes (base64 prefix)
  const mime = detectMime(value);
  const src = value.startsWith("data:") ? value : `data:${mime};base64,${value}`;
  return <img src={src} alt="cell image" className="max-w-full" />;
}

function detectMime(b64: string): string {
  const head = b64.slice(0, 12);
  if (head.startsWith("iVBORw0KGgo")) return "image/png";
  if (head.startsWith("/9j/")) return "image/jpeg";
  if (head.startsWith("R0lGO")) return "image/gif";
  if (head.startsWith("UklGR")) return "image/webp";
  return "application/octet-stream";
}
