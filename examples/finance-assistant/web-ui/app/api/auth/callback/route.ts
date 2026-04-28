// /api/auth/callback — Cognito redirects here after successful sign-in.
//
// 1. Verify `state` matches the cookie nonce (CSRF protection)
// 2. Exchange `code` for id_token + refresh_token
// 3. Verify id_token against Cognito JWKS
// 4. Mint our HttpOnly session cookie and redirect to /app

import { NextRequest, NextResponse } from "next/server";
import {
  exchangeCode, verifyIdToken, signSession, SESSION_COOKIE,
} from "@/lib/auth";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export async function GET(req: NextRequest) {
  const code = req.nextUrl.searchParams.get("code");
  const stateParam = req.nextUrl.searchParams.get("state") || "";
  const stateCookie = req.cookies.get("fa_oauth_state")?.value || "";

  if (!code) return NextResponse.redirect(new URL("/?error=no_code", req.url));

  // state format: "<nonce>.<base64url(returnTo)>"
  const [nonce, returnToEncoded] = stateParam.split(".");
  if (!nonce || nonce !== stateCookie) {
    return NextResponse.redirect(new URL("/?error=state_mismatch", req.url));
  }
  const returnTo = (() => {
    try { return Buffer.from(returnToEncoded || "", "base64url").toString("utf8") || "/app"; }
    catch { return "/app"; }
  })();

  const tokens = await exchangeCode(code);
  if (!tokens) return NextResponse.redirect(new URL("/?error=token_exchange", req.url));

  const claims = await verifyIdToken(tokens.idToken);
  if (!claims) return NextResponse.redirect(new URL("/?error=id_token_invalid", req.url));

  const jwt = await signSession({
    sub: claims.sub,
    email: claims.email,
    id_token: tokens.idToken,
    refresh_token: tokens.refreshToken,
    ttlSeconds: 3600,
  });

  const dest = returnTo.startsWith("/") ? returnTo : "/app";
  const res = NextResponse.redirect(new URL(dest, req.url));
  res.cookies.set({
    name: SESSION_COOKIE,
    value: jwt,
    httpOnly: true,
    secure: true,
    sameSite: "lax",
    path: "/",
    maxAge: 3600,
  });
  res.cookies.delete("fa_oauth_state");
  return res;
}
