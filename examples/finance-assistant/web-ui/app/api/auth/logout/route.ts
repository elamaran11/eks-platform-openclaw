// /api/auth/logout — clear our session cookie and return to landing.
//
// We don't bounce through Cognito's /logout endpoint because we're
// using direct API auth (not hosted UI), so there's no Cognito browser
// session to invalidate. The idToken in our cookie is the only auth
// state, and deleting the cookie is sufficient.

import { NextResponse } from "next/server";
import { SESSION_COOKIE } from "@/lib/auth";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export async function GET(req: Request) {
  const url = new URL("/", req.url);
  const res = NextResponse.redirect(url);
  res.cookies.delete(SESSION_COOKIE);
  return res;
}
