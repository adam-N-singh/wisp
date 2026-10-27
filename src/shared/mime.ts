// Content types for attachments and tool images, shared by main's
// `wisp-media://` handler and the box host's /media route.
import { extname } from "node:path";

const MIME: Record<string, string> = {
  ".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".gif": "image/gif", ".webp": "image/webp", ".svg": "image/svg+xml",
  ".pdf": "application/pdf", ".txt": "text/plain", ".md": "text/markdown", ".csv": "text/csv", ".json": "application/json",
  ".html": "text/html", ".xml": "application/xml", ".zip": "application/zip", ".mp3": "audio/mpeg", ".wav": "audio/wav", ".mp4": "video/mp4",
  ".m4a": "audio/mp4", ".aac": "audio/aac", ".webm": "audio/webm", ".ogg": "audio/ogg", ".opus": "audio/ogg", ".flac": "audio/flac",
  ".docx": "application/vnd.openxmlformats-officedocument.wordprocessingml.document", ".xlsx": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
};

export const mimeFor = (name: string) => MIME[extname(name).toLowerCase()] ?? "application/octet-stream";

export const MAX_ATTACHMENT_BYTES = 100 * 1024 * 1024;

/** A file name that is safe on every platform: no folders, reserved or control characters. */
export function safeFileName(filename: string): string {
  const base = filename.split(/[\\/]/).pop() ?? "";
  return base.replace(/[<>:"/\\|?*\u0000-\u001f]/g, "_").slice(0, 200) || "file";
}
