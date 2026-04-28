// App-layer auth middleware.
//
// /api/auth/*   — public (login/callback/logout/me)
// /api/chat     — protected; 401 if no session
// /app          — protected; redirect to /api/auth/login if no session
// everything else on /  — public (landing page + static assets)
//
// This replaces the ALB's cognito auth action, which is all-or-nothing
// per ingress and prevented a public landing on the same hostname.

import { NextResponse } from "next/server";
import type { NextRequest } from "next/server";
import { jwtVerify } from "jose";

const SESSION_COOKIE = "fa_session";

function secret(): Uint8Array | null {
  const s = process.env.SESSION_SECRET;
  if (!s) return null;
  return new TextEncoder().encode(s);
}

// Edge runtime can't import lib/auth.ts (it uses crypto.randomBytes)
// so we duplicate the minimal verify here — HS256 + SESSION_SECRET.
async function sessionOk(token: string | undefined): Promise<boolean> {
  if (!token) return false;
  const key = secret();
  if (!key) return false;
  try { await jwtVerify(token, key); return true; } catch { return false; }
}

export async function middleware(req: NextRequest) {
  const { pathname } = req.nextUrl;
  const token = req.cookies.get(SESSION_COOKIE)?.value;

  if (pathname.startsWith("/app")) {
    if (!(await sessionOk(token))) {
      const login = new URL("/api/auth/login", req.url);
      login.searchParams.set("returnTo", pathname + req.nextUrl.search);
      return NextResponse.redirect(login);
    }
    return NextResponse.next();
  }

  if (pathname === "/api/chat") {
    if (!(await sessionOk(token))) {
      return NextResponse.json({ error: "unauth" }, { status: 401 });
    }
    return NextResponse.next();
  }

  return NextResponse.next();
}

export const config = {
  matcher: ["/app/:path*", "/api/chat"],
};
