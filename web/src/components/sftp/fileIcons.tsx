import {
  Archive,
  FileAudio,
  FileCode,
  FileImage,
  FileSpreadsheet,
  FileText,
  FileVideo,
  Folder,
  FolderSymlink,
  Link2,
  Lock,
  Terminal,
} from "lucide-react"
import type { ComponentType } from "react"
import type { SftpEntry } from "@/lib/api/services"
import { extension } from "./pathUtil"

type IconType = ComponentType<{ className?: string }>

const CODE = new Set([
  "ts", "tsx", "js", "jsx", "mjs", "cjs",
  "go", "rs", "py", "rb", "php", "java", "kt", "swift", "c", "cc", "cpp", "h", "hpp",
  "cs", "scala", "lua", "ex", "exs", "erl", "dart", "vue", "svelte",
  "html", "css", "scss", "sass", "less",
  "json", "yaml", "yml", "toml", "xml", "sql", "graphql", "proto",
])
const SHELL = new Set(["sh", "bash", "zsh", "fish", "ps1", "bat", "cmd"])
const TEXT = new Set([
  "txt", "md", "markdown", "log", "rst", "tex", "cfg", "ini", "conf", "env",
  "lock", "gitignore", "dockerignore", "editorconfig",
])
const IMAGE = new Set([
  "png", "jpg", "jpeg", "gif", "webp", "svg", "ico", "bmp", "tiff", "avif", "heic", "heif",
])
const AUDIO = new Set(["mp3", "wav", "flac", "ogg", "aac", "m4a", "opus"])
const VIDEO = new Set(["mp4", "mkv", "mov", "avi", "webm", "flv", "wmv", "m4v"])
const ARCHIVE = new Set([
  "zip", "tar", "gz", "tgz", "bz2", "xz", "7z", "rar", "zst", "deb", "rpm", "apk",
])
const SHEET = new Set(["xls", "xlsx", "csv", "tsv", "ods"])
const KEY = new Set(["key", "pem", "crt", "cer", "pub", "p12", "pfx", "asc"])

export function iconForEntry(e: SftpEntry): IconType {
  if (e.is_link) return e.is_dir ? FolderSymlink : Link2
  if (e.is_dir) return Folder
  const ext = extension(e.name)
  if (CODE.has(ext)) return FileCode
  if (SHELL.has(ext)) return Terminal
  if (IMAGE.has(ext)) return FileImage
  if (AUDIO.has(ext)) return FileAudio
  if (VIDEO.has(ext)) return FileVideo
  if (ARCHIVE.has(ext)) return Archive
  if (SHEET.has(ext)) return FileSpreadsheet
  if (KEY.has(ext)) return Lock
  if (TEXT.has(ext)) return FileText
  return FileText
}

// Icon for a bare filename (no stat) — used by the transfer dock, where a
// queued upload is known only by name.
export function iconForName(name: string): IconType {
  return iconForEntry({ name, is_dir: false, is_link: false } as SftpEntry)
}

export function iconColorForEntry(e: SftpEntry): string {
  if (e.is_link) return "text-cyan-500 dark:text-cyan-400"
  if (e.is_dir) return "text-sky-500 dark:text-sky-400"
  const ext = extension(e.name)
  if (IMAGE.has(ext)) return "text-emerald-500 dark:text-emerald-400"
  if (CODE.has(ext)) return "text-violet-500 dark:text-violet-400"
  if (SHELL.has(ext)) return "text-amber-500 dark:text-amber-400"
  if (ARCHIVE.has(ext)) return "text-orange-500 dark:text-orange-400"
  if (AUDIO.has(ext) || VIDEO.has(ext)) return "text-pink-500 dark:text-pink-400"
  if (SHEET.has(ext)) return "text-green-500 dark:text-green-400"
  if (KEY.has(ext)) return "text-rose-500 dark:text-rose-400"
  return "text-muted-foreground"
}

// Whether the inline text preview / editor is likely to be useful.
const TEXTUAL = new Set<string>([...CODE, ...SHELL, ...TEXT])
const IMAGE_PREVIEW = IMAGE
const SIZE_LIMIT = 2 * 1024 * 1024

export function isLikelyText(e: SftpEntry): boolean {
  if (e.is_dir) return false
  const ext = extension(e.name)
  if (ext === "") return e.size > 0 && e.size <= SIZE_LIMIT // try text for extensionless small files
  return TEXTUAL.has(ext) && e.size <= SIZE_LIMIT
}

export function isPreviewableImage(e: SftpEntry): boolean {
  if (e.is_dir) return false
  return IMAGE_PREVIEW.has(extension(e.name))
}

export function isEditable(e: SftpEntry): boolean {
  return isLikelyText(e) && !e.is_link
}
