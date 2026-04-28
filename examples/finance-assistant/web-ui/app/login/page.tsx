// /login — kicks the Cognito OAuth flow by asking the browser to hit
// /app, which sits behind the ALB's Cognito auth action. The ALB sees
// an unauthenticated request to a protected path and redirects to the
// Cognito hosted UI, which (after successful sign-in) bounces back to
// /oauth2/idpresponse → /app.
//
// No secrets or client-id wiring needed here — the ALB already owns
// the OAuth authorization request. This is a thin redirect page that
// gives us a clean marketing-facing URL (/login) decoupled from the
// protected app path.

import { redirect } from "next/navigation";

export const dynamic = "force-dynamic";

export default function LoginPage() {
  redirect("/app");
}
