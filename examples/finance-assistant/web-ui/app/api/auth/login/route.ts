// /api/auth/login — start the Cognito OAuth code flow.
//
// We mint a one-time `state` nonce, stash it in a short-lived cookie
// so /callback can verify it came from us, then 302 to Cognito.

import { NextRequest, NextResponse } from "next/server";
import { randomBytes } from "crypto";
import { authorizeUrl } from "@/lib/auth";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export async function GET(req: NextRequest) {
  const state = randomBytes(16).toString("hex");
  const returnTo = req.nextUrl.searchParams.get("returnTo") || "/app";
  // Encode the returnTo into the state so callback can send the user
  // back to where they started (e.g. direct link to /app/foo).
  const stateWithReturn = `${state}.${Buffer.from(returnTo).toString("base64url")}`;

  const url = authorizeUrl(stateWithReturn);
  const res = NextResponse.redirect(url);
  res.cookies.set({
    name: "fa_oauth_state",
    value: state,
    httpOnly: true,
    secure: true,
    sameSite: "lax",
    path: "/",
    maxAge: 600,
  });
  return res;
}
