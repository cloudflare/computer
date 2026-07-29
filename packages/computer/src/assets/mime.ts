// Minimal extension → content-type lookup.
//
// Just enough to set a sensible Content-Type on shared assets
// without pulling a multi-hundred-entry mime database into the
// bundle. Covers the file kinds an agent is likely to share —
// images, text, common documents, archives — and falls back to
// application/octet-stream for anything unrecognised.
//
// Callers that know better pass ShareOptions.contentType, which
// always wins over this table.

const TYPES: Record<string, string> = {
  // images
  png: "image/png",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  gif: "image/gif",
  webp: "image/webp",
  svg: "image/svg+xml",
  avif: "image/avif",
  bmp: "image/bmp",
  ico: "image/x-icon",
  // text & code
  txt: "text/plain",
  md: "text/markdown",
  csv: "text/csv",
  html: "text/html",
  htm: "text/html",
  css: "text/css",
  js: "text/javascript",
  mjs: "text/javascript",
  json: "application/json",
  xml: "application/xml",
  yaml: "application/yaml",
  yml: "application/yaml",
  // documents
  pdf: "application/pdf",
  // archives
  zip: "application/zip",
  gz: "application/gzip",
  tar: "application/x-tar",
  // media
  mp4: "video/mp4",
  webm: "video/webm",
  mp3: "audio/mpeg",
  wav: "audio/wav",
};

export const DEFAULT_CONTENT_TYPE = "application/octet-stream";

// Infer a content type from a path or filename's extension. The
// match is case-insensitive. Returns DEFAULT_CONTENT_TYPE when the
// path has no extension or the extension isn't in the table.
export function contentTypeForPath(path: string): string {
  const base = path.slice(path.lastIndexOf("/") + 1);
  const dot = base.lastIndexOf(".");
  if (dot <= 0) return DEFAULT_CONTENT_TYPE;
  const ext = base.slice(dot + 1).toLowerCase();
  return TYPES[ext] ?? DEFAULT_CONTENT_TYPE;
}
