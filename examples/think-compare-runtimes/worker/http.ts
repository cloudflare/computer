import type { RunSession } from "./runs";

export interface ApiHandlers {
  startRun(): Promise<RunSession>;
  stopRun(runId: string): Promise<void>;
}

export async function handleApiRequest(
  request: Request,
  handlers: ApiHandlers,
): Promise<Response | null> {
  const url = new URL(request.url);

  if (url.pathname === "/api/runs") {
    if (request.method !== "POST") {
      return new Response("Method Not Allowed", {
        status: 405,
        headers: { Allow: "POST" },
      });
    }

    return Response.json(await handlers.startRun(), { status: 201 });
  }

  const stopMatch = /^\/api\/runs\/([^/]+)\/stop$/.exec(url.pathname);
  if (stopMatch) {
    if (request.method !== "POST") {
      return new Response("Method Not Allowed", {
        status: 405,
        headers: { Allow: "POST" },
      });
    }

    await handlers.stopRun(decodeURIComponent(stopMatch[1] ?? ""));
    return new Response(null, { status: 204 });
  }

  return null;
}
