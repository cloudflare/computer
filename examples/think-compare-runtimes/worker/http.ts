import type { RunSession } from "./runs";

export async function handleApiRequest(
  request: Request,
  startRun: () => Promise<RunSession>,
): Promise<Response | null> {
  const url = new URL(request.url);

  if (url.pathname !== "/api/runs") {
    return null;
  }

  if (request.method !== "POST") {
    return new Response("Method Not Allowed", {
      status: 405,
      headers: { Allow: "POST" },
    });
  }

  return Response.json(await startRun(), { status: 201 });
}
