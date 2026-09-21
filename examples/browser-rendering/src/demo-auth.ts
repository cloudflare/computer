const LOCAL_HOSTS = new Set(["localhost", "127.0.0.1", "[::1]"]);

export function authorizeDemoRequest(request: Request, token: string | undefined): Response | null {
  if (LOCAL_HOSTS.has(new URL(request.url).hostname)) return null;
  if (!token) {
    return new Response("Set the DEMO_TOKEN secret before deploying this example.", {
      status: 503,
    });
  }

  const expected = `Basic ${encodeBase64Utf8(`demo:${token}`)}`;
  if (constantTimeEqual(request.headers.get("authorization") ?? "", expected)) return null;
  return new Response("Authentication required", {
    status: 401,
    headers: { "www-authenticate": 'Basic realm="Browser demo", charset="UTF-8"' },
  });
}

function encodeBase64Utf8(value: string): string {
  const bytes = new TextEncoder().encode(value);
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
}

function constantTimeEqual(left: string, right: string): boolean {
  const encoder = new TextEncoder();
  const leftBytes = encoder.encode(left);
  const rightBytes = encoder.encode(right);
  const length = Math.max(leftBytes.length, rightBytes.length);
  let mismatch = leftBytes.length ^ rightBytes.length;
  for (let index = 0; index < length; index += 1) {
    mismatch |= (leftBytes[index] ?? 0) ^ (rightBytes[index] ?? 0);
  }
  return mismatch === 0;
}
