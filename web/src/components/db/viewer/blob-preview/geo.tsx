"use client";

import { MapContainer, TileLayer, GeoJSON, Marker } from "react-leaflet";
import L from "leaflet";
import "leaflet/dist/leaflet.css";
import { useMemo } from "react";

export function GeoPreview({ value }: { value: unknown }) {
  const { kind, parsed, center } = useMemo(() => parseGeo(value), [value]);
  if (kind === "error") return <div className="text-destructive">无法解析为地理数据</div>;
  return (
    <MapContainer center={center} zoom={5} style={{ height: 360 }}>
      <TileLayer url="https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png" attribution="© OpenStreetMap" />
      {kind === "geojson" && <GeoJSON data={parsed as GeoJSON.Feature} />}
      {kind === "wkt-point" && <Marker position={center} icon={L.divIcon({ html: "📍", iconSize: [20, 20] })} />}
    </MapContainer>
  );
}

function parseGeo(value: unknown): { kind: "geojson" | "wkt-point" | "error"; parsed: unknown; center: [number, number] } {
  if (typeof value !== "string") return { kind: "error", parsed: null, center: [0, 0] };
  const t = value.trim();
  // GeoJSON
  if (t.startsWith("{")) {
    try {
      const g = JSON.parse(t);
      const c = guessCenterFromGeoJSON(g);
      return { kind: "geojson", parsed: g, center: c };
    } catch { /* fall through */ }
  }
  // WKT POINT
  const m = /^POINT\s*\(\s*(-?[\d.]+)\s+(-?[\d.]+)\s*\)/i.exec(t);
  if (m) return { kind: "wkt-point", parsed: t, center: [parseFloat(m[2]), parseFloat(m[1])] };
  return { kind: "error", parsed: null, center: [0, 0] };
}

function guessCenterFromGeoJSON(g: unknown): [number, number] {
  if (g && typeof g === "object") {
    const obj = g as { geometry?: { coordinates?: unknown }; coordinates?: unknown };
    if (obj.geometry?.coordinates && Array.isArray(obj.geometry.coordinates)) {
      const c = flatFirstCoord(obj.geometry.coordinates);
      if (c) return [c[1], c[0]];
    }
    if (Array.isArray(obj.coordinates)) {
      const c = flatFirstCoord(obj.coordinates);
      if (c) return [c[1], c[0]];
    }
  }
  return [0, 0];
}

function flatFirstCoord(x: unknown): [number, number] | null {
  if (Array.isArray(x) && typeof x[0] === "number") return x as [number, number];
  if (Array.isArray(x) && Array.isArray(x[0])) return flatFirstCoord(x[0]);
  return null;
}
