// Two ADAPTER_URLs let us flip traffic between the legacy shared sandbox
// and the per-user session-router without rebuilding the image. Deploy-time
// flag: USE_SESSION_ROUTER=true sends /chat to the router.
const LEGACY_URL  = process.env.LEGACY_ADAPTER_URL || "http://finance-sandbox.finance-assistant.svc.cluster.local:18790";
const ROUTER_URL  = process.env.ROUTER_URL || "http://finance-session-router.finance-assistant.svc.cluster.local:18790";
const USE_ROUTER  = process.env.USE_SESSION_ROUTER === "true";
const ADAPTER_URL = USE_ROUTER ? ROUTER_URL : LEGACY_URL;

export async function POST(req: Request) {
  const { message, sessionId } = await req.json();

  // The ALB signs x-amzn-oidc-data after Cognito auth. The session-router
  // reads `sub` from it to pick the per-user sandbox. Forward it verbatim.
  const oidc = req.headers.get("x-amzn-oidc-data") || "";
  const headers: Record<string, string> = { "Content-Type": "application/json" };
  if (oidc) headers["x-amzn-oidc-data"] = oidc;

  const upstream = await fetch(`${ADAPTER_URL}/chat`, {
    method: "POST",
    headers,
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
