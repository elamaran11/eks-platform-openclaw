import { forwardToSandbox, userIdFromHeaders } from "@/lib/sandbox";

export const runtime = "nodejs";

export async function POST(req: Request) {
  const userId = userIdFromHeaders(req.headers);
  const body = await req.json();

  const upstream = await forwardToSandbox("/v1/chat/completions", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-user-id": userId,
    },
    body: JSON.stringify({ ...body, stream: true }),
  });

  return new Response(upstream.body, {
    headers: {
      "content-type": "text/event-stream",
      "cache-control": "no-cache",
      "connection": "keep-alive",
    },
  });
}
