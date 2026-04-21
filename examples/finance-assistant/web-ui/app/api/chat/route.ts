const ADAPTER_URL = process.env.ADAPTER_URL || "http://finance-sandbox.finance-assistant.svc.cluster.local:18790";

export async function POST(req: Request) {
  const { message, sessionId } = await req.json();

  const upstream = await fetch(`${ADAPTER_URL}/chat`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ message, sessionId: sessionId || "web" }),
    // @ts-expect-error node fetch
    duplex: "half",
  });

  return new Response(upstream.body, {
    status: upstream.status,
    headers: {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache, no-transform",
      "Connection": "keep-alive",
      "X-Accel-Buffering": "no",
    },
  });
}

export const dynamic = "force-dynamic";
export const runtime = "nodejs";
