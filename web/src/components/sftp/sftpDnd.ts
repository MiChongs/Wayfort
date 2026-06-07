// Shared drag-and-drop contract for moving entries between the list, the tree,
// and the breadcrumb. A custom MIME type keeps internal moves distinct from OS
// file drops (which carry the "Files" type and feed the upload pipeline).
export const SFTP_MOVE_MIME = "application/x-sftp-move"

export type SftpMovePayload = { paths: string[] }

export function readMovePayload(dt: DataTransfer): string[] | null {
  if (!dt.types.includes(SFTP_MOVE_MIME)) return null
  try {
    const parsed = JSON.parse(dt.getData(SFTP_MOVE_MIME)) as SftpMovePayload
    return Array.isArray(parsed.paths) ? parsed.paths : null
  } catch {
    return null
  }
}
