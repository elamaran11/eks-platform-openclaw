// /api/auth/logout — clear local session, then bounce to Cognito /logout
// so the hosted UI session is also invalidated. User lands back on /.

import { NextResponse } from "next/server";
import { logoutUrl, SESSION_COOKIE } from "@/lib/auth";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export async function GET() {
  const res = NextResponse.redirect(logoutUrl());
  res.cookies.delete(SESSION_COOKIE);
  return res;
}
