import { forwardToSandbox, userIdFromHeaders } from "@/lib/sandbox";

export const runtime = "nodejs";

export async function GET(req: Request) {
  const userId = userIdFromHeaders(req.headers);
  const url = new URL(req.url);
  const file = url.searchParams.get("file") ?? "goals.md";

  const upstream = await forwardToSandbox(`/workspace/${encodeURIComponent(file)}`, {
    method: "GET",
    headers: { "x-user-id": userId },
  });
  return new Response(upstream.body, {
    status: upstream.status,
    headers: { "content-type": "text/markdown" },
  });
}

export async function PUT(req: Request) {
  const userId = userIdFromHeaders(req.headers);
  const { file, content } = await req.json();
  const upstream = await forwardToSandbox(`/workspace/${encodeURIComponent(file)}`, {
    method: "PUT",
    headers: { "content-type": "text/markdown", "x-user-id": userId },
    body: content,
  });
  return new Response(null, { status: upstream.status });
}
