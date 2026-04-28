import { NextResponse } from "next/server";
import type { NextRequest } from "next/server";

// Dual-host routing.
//
// - finassist.* is the authenticated app host. Its ALB ingress gates
//   every path with Cognito. We redirect "/" to "/app" so users who
//   land on root go straight into the chat instead of seeing the
//   marketing landing page (which is pointless once signed in).
// - finwelcome.* is the public marketing host. Its ALB ingress has no
//   auth. We leave "/" as-is (landing page) and redirect "/app" to
//   the authenticated host so visitors who click "Sign in" cross over
//   to the auth-gated domain.
//
// Everything else passes through untouched.

export function middleware(req: NextRequest) {
  const host = req.headers.get("host") || "";
  const { pathname } = req.nextUrl;
  const isAuthHost = host.startsWith("finassist.");
  const isLandingHost = host.startsWith("finwelcome.");

  if (isAuthHost && pathname === "/") {
    const url = req.nextUrl.clone();
    url.pathname = "/app";
    return NextResponse.redirect(url);
  }

  if (isLandingHost && pathname.startsWith("/app")) {
    // Cross-domain redirect — marketing host can't serve the app since
    // the API calls need the Cognito cookie on the auth host.
    const target = new URL("https://finassist.elamaras.people.aws.dev/app");
    return NextResponse.redirect(target);
  }

  return NextResponse.next();
}

export const config = {
  // Skip static assets and Next internals so the redirect logic only
  // runs on page routes.
  matcher: ["/((?!_next/|favicon.ico|api/).*)"],
};
