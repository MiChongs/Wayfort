// Protocol-agnostic file classification shared by the SFTP and OSS workspaces.
// A "kind" decides which viewer/editor the FileViewer dispatcher mounts.

export type ViewerKind = "image" | "pdf" | "office" | "text" | "video" | "audio" | "unknown"

const IMAGE = new Set([
  "jpg", "jpeg", "png", "gif", "webp", "bmp", "ico", "avif", "svg",
])
// Formats browsers can't paint natively — surfaced as image but the viewer
// shows a "download to view" hint rather than a broken <img>.
const IMAGE_OPAQUE = new Set(["heic", "heif", "tiff", "tif", "raw", "cr2", "nef", "arw", "dng"])
// Raster formats the in-browser editor (filerobot) can load + re-export.
const RASTER_EDITABLE = new Set(["jpg", "jpeg", "png", "webp", "bmp"])
const PDF = new Set(["pdf"])
// OnlyOffice-handled document formats.
const OFFICE = new Set([
  "doc", "docx", "dot", "dotx", "odt", "rtf",
  "xls", "xlsx", "xlt", "xltx", "ods", "csv",
  "ppt", "pptx", "pot", "potx", "odp",
])
const OFFICE_EDITABLE = new Set(["docx", "xlsx", "pptx", "odt", "ods", "odp", "csv", "rtf", "txt"])
const VIDEO = new Set(["mp4", "webm", "mov", "m4v", "ogv"])
const AUDIO = new Set(["mp3", "wav", "flac", "ogg", "aac", "m4a", "opus", "weba"])
const TEXT = new Set([
  "txt", "md", "markdown", "log", "rst", "csv", "tsv",
  "json", "yaml", "yml", "toml", "xml", "ini", "conf", "cfg", "env", "properties",
  "js", "jsx", "ts", "tsx", "mjs", "cjs", "go", "rs", "py", "rb", "php", "java", "kt",
  "c", "cc", "cpp", "h", "hpp", "cs", "swift", "scala", "lua", "sh", "bash", "zsh",
  "sql", "graphql", "proto", "html", "css", "scss", "less", "vue", "svelte", "dockerfile",
])

export function extOf(name: string): string {
  const base = name.split(/[\\/]/).pop() || name
  const i = base.lastIndexOf(".")
  return i >= 0 ? base.slice(i + 1).toLowerCase() : ""
}

export function viewerKind(name: string): ViewerKind {
  const e = extOf(name)
  if (IMAGE.has(e) || IMAGE_OPAQUE.has(e)) return "image"
  if (PDF.has(e)) return "pdf"
  if (OFFICE.has(e)) return "office"
  if (VIDEO.has(e)) return "video"
  if (AUDIO.has(e)) return "audio"
  if (TEXT.has(e)) return "text"
  return "unknown"
}

/** Browser can paint it directly in an <img>. */
export function isPaintableImage(name: string): boolean {
  return IMAGE.has(extOf(name))
}

/** EXIF metadata is worth probing (raster photos, not vector/icon). */
export function hasExifPotential(name: string): boolean {
  const e = extOf(name)
  return ["jpg", "jpeg", "tiff", "tif", "heic", "heif", "png", "webp", "avif"].includes(e)
}

/** In-browser raster editor (filerobot) can open + save it. */
export function isRasterEditable(name: string): boolean {
  return RASTER_EDITABLE.has(extOf(name))
}

/** OnlyOffice can render it. */
export function isOfficeDoc(name: string): boolean {
  return OFFICE.has(extOf(name))
}

/** OnlyOffice can save edits back for it. */
export function isOfficeEditable(name: string): boolean {
  return OFFICE_EDITABLE.has(extOf(name))
}
