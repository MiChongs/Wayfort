"use client";

export function HexPreview({ value }: { value: unknown }) {
  const s = typeof value === "string" ? value : String(value ?? "");
  const lines: string[] = [];
  for (let i = 0; i < s.length; i += 16) {
    const chunk = s.slice(i, i + 16);
    const hex = Array.from(chunk).map((c) => c.charCodeAt(0).toString(16).padStart(2, "0")).join(" ");
    const ascii = Array.from(chunk).map((c) => (/[ -~]/.test(c) ? c : ".")).join("");
    lines.push(`${i.toString(16).padStart(8, "0")}  ${hex.padEnd(48, " ")}  ${ascii}`);
  }
  return <pre className="text-xs">{lines.join("\n")}</pre>;
}
