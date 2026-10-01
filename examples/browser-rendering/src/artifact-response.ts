export function artifactResponseHeaders(filename: string): Record<string, string> {
  return {
    "content-type": artifactContentType(filename),
    "content-disposition": `inline; filename="${filename}"`,
    "cache-control": "private, max-age=300",
    "x-content-type-options": "nosniff",
    "content-security-policy": "sandbox; default-src 'none'",
  };
}

function artifactContentType(filename: string): string {
  if (filename.endsWith(".png")) return "image/png";
  if (filename.endsWith(".json")) return "application/json; charset=utf-8";
  return "text/markdown; charset=utf-8";
}
