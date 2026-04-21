const SANDBOX_URL = process.env.SANDBOX_URL || "http://finance-sandbox.finance-assistant.svc.cluster.local:18789";

export async function forwardToSandbox(path: string, init: RequestInit) {
  const url = `${SANDBOX_URL}${path}`;
  return fetch(url, { ...init, cache: "no-store" });
}

export function userIdFromHeaders(headers: Headers): string {
  // ALB with Cognito injects x-amzn-oidc-identity (subject claim).
  return headers.get("x-amzn-oidc-identity") ?? "anonymous";
}
