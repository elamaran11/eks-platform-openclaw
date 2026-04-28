// /api/chat — SSE proxy to the in-cluster adapter or session-router.
//
// Auth: middleware.ts already verified the session cookie before we get
// here. We decode the session to extract the user's sub and forward it
// to the backend in an x-amzn-oidc-data-shaped header so the router can
// route to the per-user sandbox without ALB auth.

import { NextRequest } from "next/server";
import { SESSION_COOKIE, verifySession } from "@/lib/auth";

const LEGACY_URL  = process.env.LEGACY_ADAPTER_URL || "http://finance-sandbox.finance-assistant.svc.cluster.local:18790";
const ROUTER_URL  = process.env.ROUTER_URL || "http://finance-session-router.finance-assistant.svc.cluster.local:18790";
const USE_ROUTER  = process.env.USE_SESSION_ROUTER === "true";
const ADAPTER_URL = USE_ROUTER ? ROUTER_URL : LEGACY_URL;

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export async function POST(req: NextRequest) {
  const body = await req.text();

  // Reconstruct an x-amzn-oidc-data shaped header: three dot-joined
  // base64 segments, middle segment = JSON claims. session-router only
  // parses the middle segment for `sub`, so the signature is irrelevant.
  const token = req.cookies.get(SESSION_COOKIE)?.value;
  const session = token ? await verifySession(token) : null;
  const headers: Record<string, string> = { "Content-Type": "application/json" };
  if (session) {
    const claims = Buffer.from(JSON.stringify({ sub: session.sub, email: session.email })).toString("base64url");
    headers["x-amzn-oidc-data"] = `app.${claims}.sig`;
  }

  const upstream = await fetch(`${ADAPTER_URL}/chat`, {
    method: "POST",
    headers,
    body,
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
