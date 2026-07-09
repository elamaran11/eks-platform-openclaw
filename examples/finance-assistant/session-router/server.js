// session-router: thin shim over the agent-sandbox declarative CRDs.
//
// It no longer applies static templated manifests. It owns exactly two
// jobs:
//   1. Provisioning — get-or-create ONE SandboxClaim per authenticated
//      user. The agent-sandbox controller binds the claim to a warm
//      sandbox (fast) or cold-creates one (empty pool). The claim's
//      lifecycle handles idle teardown, replacing the reaper CronJob.
//   2. Proxying — stream the /chat SSE from the bound sandbox's adapter,
//      passing the user's suffix so the sandbox can route to that user's
//      per-user openclaw agent + workspace subdir.
//
// Flow per /chat request:
//  1. Read x-amzn-oidc-data (JWT injected by ALB Cognito auth) -> sub
//  2. Hash sub -> short stable suffix
//  3. get-or-create SandboxClaim/finance-claim-<suffix>; renew its sliding
//     idle lease (lifecycle.shutdownTime = now + IDLE_TTL)
//  4. Wait for claim.status Ready + sandbox.name; read the bound
//     Sandbox.status.serviceFQDN
//  5. Proxy /chat to <serviceFQDN>:18790, injecting the suffix in the body
//
// No secrets pass through this process. Its only privileges are the narrow
// RBAC in k8s/deployment.yaml: get/list/create/patch/delete SandboxClaim,
// and get/list Sandbox (to read serviceFQDN) in this namespace.

const http = require("http");
const crypto = require("crypto");
const k8s = require("@kubernetes/client-node");

const PORT = parseInt(process.env.PORT || "18790", 10);
const NAMESPACE = process.env.NAMESPACE || "finance-assistant";
const WARM_POOL = process.env.WARM_POOL || "finance";
const SANDBOX_READY_TIMEOUT_MS = parseInt(process.env.SANDBOX_READY_TIMEOUT_MS || "300000", 10);
// Sliding idle lease. Each message pushes shutdownTime to now + this, so a
// session is torn down by the controller only after this much silence.
const IDLE_TTL_SECONDS = parseInt(process.env.IDLE_TTL_SECONDS || "1800", 10);
// Read-only mode: do NOT provision per-user claims; proxy to the legacy
// shared sandbox. Smoke-tests the SSE proxy path.
const READ_ONLY = process.env.ROUTER_READ_ONLY === "true";
const LEGACY_BACKEND = process.env.LEGACY_BACKEND || "finance-sandbox.finance-assistant.svc.cluster.local";
const USER_LABEL = "finance.x-k8s.io/user-suffix";

// ALB verifies the Cognito JWT and signs x-amzn-oidc-data before
// forwarding. We rely on that upstream verification; if you relocate this
// behind a different gateway, add JWKS verification here.
function extractUserSub(req) {
  const oidc = req.headers["x-amzn-oidc-data"];
  if (!oidc) return null;
  const parts = oidc.split(".");
  if (parts.length < 2) return null;
  try {
    const payload = JSON.parse(Buffer.from(parts[1], "base64").toString("utf8"));
    return payload.sub || payload.email || null;
  } catch {
    return null;
  }
}

function userSuffix(sub) {
  // 10 hex chars = 40 bits, comfortable for label/name length (<=63) and
  // avoids collisions inside a single tenant pool.
  return crypto.createHash("sha256").update(sub).digest("hex").slice(0, 10);
}

const kc = new k8s.KubeConfig();
kc.loadFromDefault();
const customApi = kc.makeApiClient(k8s.CustomObjectsApi);

const CLAIM_GROUP = "extensions.agents.x-k8s.io";
const CLAIM_VERSION = "v1beta1";
const CLAIM_PLURAL = "sandboxclaims";
const SANDBOX_GROUP = "agents.x-k8s.io";
const SANDBOX_VERSION = "v1beta1";
const SANDBOX_PLURAL = "sandboxes";

// Retry transient k8s API errors. The client raises plain
// Error("HTTP request failed") for ECONN/EAI/socket-closed — retriable.
// 404 / 409 / 422 are intentional flow-control and pass through unchanged.
async function withRetry(label, fn, { attempts = 4, baseMs = 500 } = {}) {
  let lastErr;
  for (let i = 0; i < attempts; i++) {
    try { return await fn(); }
    catch (e) {
      const status = e?.response?.statusCode;
      if (status === 404 || status === 409 || status === 422) throw e;
      lastErr = e;
      const wait = baseMs * Math.pow(2, i);
      console.warn(`[router] ${label} failed (attempt ${i + 1}/${attempts}): ${e?.message || e}; retry in ${wait}ms`);
      await new Promise((r) => setTimeout(r, wait));
    }
  }
  throw lastErr;
}

function claimName(suffix) { return `finance-claim-${suffix}`; }
function leaseTime() { return new Date(Date.now() + IDLE_TTL_SECONDS * 1000).toISOString(); }

function buildClaim(suffix, sub) {
  return {
    apiVersion: `${CLAIM_GROUP}/${CLAIM_VERSION}`,
    kind: "SandboxClaim",
    metadata: {
      name: claimName(suffix),
      namespace: NAMESPACE,
      labels: { [USER_LABEL]: suffix, app: "finance-sandbox" },
      annotations: {
        // Only the suffix/hash is stored; sub itself never touches etcd.
        "finance.x-k8s.io/sub-hash": crypto.createHash("sha256").update(sub).digest("hex").slice(0, 16),
      },
    },
    spec: {
      warmPoolRef: { name: WARM_POOL },
      // Stamp the per-user label onto the bound (warm) pod — the one claim
      // field that reaches a warm pod without forcing a cold start. The
      // NetworkPolicies key on this label.
      additionalPodMetadata: { labels: { [USER_LABEL]: suffix } },
      // Idle teardown: the controller deletes the bound Sandbox at
      // shutdownTime. Default policy is Retain — must set Delete. The
      // shared EFS state lives outside this lifecycle, so user files
      // survive teardown.
      lifecycle: { shutdownPolicy: "Delete", shutdownTime: leaseTime() },
    },
  };
}

// get-or-create the user's claim and renew its sliding idle lease.
async function ensureClaim(suffix, sub) {
  const name = claimName(suffix);
  try {
    await withRetry("Claim get", () => customApi.getNamespacedCustomObject(
      CLAIM_GROUP, CLAIM_VERSION, NAMESPACE, CLAIM_PLURAL, name,
    ));
    // Exists — renew the lease so an active session isn't reaped.
    await renewLease(suffix);
  } catch (e) {
    if (e?.response?.statusCode === 404) {
      try {
        await withRetry("Claim create", () => customApi.createNamespacedCustomObject(
          CLAIM_GROUP, CLAIM_VERSION, NAMESPACE, CLAIM_PLURAL, buildClaim(suffix, sub),
        ));
      } catch (ce) {
        // Lost a create race with another replica/tab — the claim now
        // exists; renew its lease and proceed.
        if (ce?.response?.statusCode === 409) { await renewLease(suffix); }
        else { throw ce; }
      }
    } else { throw e; }
  }
  return { name };
}

// Push the sliding lease forward. Called on every message.
async function renewLease(suffix) {
  await withRetry("Claim lease patch", () => customApi.patchNamespacedCustomObject(
    CLAIM_GROUP, CLAIM_VERSION, NAMESPACE, CLAIM_PLURAL, claimName(suffix),
    { spec: { lifecycle: { shutdownPolicy: "Delete", shutdownTime: leaseTime() } } },
    undefined, undefined, undefined,
    { headers: { "Content-Type": "application/merge-patch+json" } },
  ));
}

function isReady(conditions) {
  const c = (conditions || []).find((x) => x.type === "Ready");
  return c?.status === "True";
}

// Poll the claim until it reports Ready + a bound sandbox name, then read
// that Sandbox's serviceFQDN (the stable DNS to proxy to).
async function waitForBoundSandbox(suffix, deadlineMs) {
  const started = Date.now();
  const name = claimName(suffix);
  while (Date.now() - started < deadlineMs) {
    try {
      const resp = await customApi.getNamespacedCustomObject(
        CLAIM_GROUP, CLAIM_VERSION, NAMESPACE, CLAIM_PLURAL, name,
      );
      const status = resp.body?.status || {};
      const sandboxName = status.sandbox?.name;
      if (isReady(status.conditions) && sandboxName) {
        const sb = await customApi.getNamespacedCustomObject(
          SANDBOX_GROUP, SANDBOX_VERSION, NAMESPACE, SANDBOX_PLURAL, sandboxName,
        );
        const fqdn = sb.body?.status?.serviceFQDN;
        if (fqdn) return { sandboxName, fqdn };
      }
    } catch (e) {
      // 404 on the sandbox is transient (controller still creating the
      // Service); keep polling until the deadline.
    }
    await new Promise((r) => setTimeout(r, 750));
  }
  return null;
}

function sseWrite(res, data) { res.write(`data: ${JSON.stringify(data)}\n\n`); }

// Proxy the SSE /chat stream to the bound sandbox's adapter, injecting the
// user suffix into the body so the adapter routes to that user's per-user
// openclaw agent (`openclaw agent --agent pod-agent-<suffix>`).
async function proxyChat(res, backendHost, suffix, bodyBuf) {
  // Augment the incoming body with the suffix. The web-ui sends
  // {message, sessionId}; the adapter now also needs {suffix}.
  let body = bodyBuf;
  try {
    const parsed = JSON.parse(bodyBuf.toString("utf8") || "{}");
    parsed.suffix = suffix;
    body = Buffer.from(JSON.stringify(parsed));
  } catch {
    // Non-JSON body — forward as-is (adapter will 400).
  }
  return new Promise((resolve) => {
    const proxy = http.request(
      {
        host: backendHost, port: 18790, path: "/chat", method: "POST",
        headers: { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(body) },
      },
      (upstream) => {
        upstream.on("data", (chunk) => { try { res.write(chunk); } catch {} });
        upstream.on("end", () => { try { res.end(); } catch {} resolve(); });
        upstream.on("error", () => { try { res.end(); } catch {} resolve(); });
      },
    );
    proxy.on("error", (err) => {
      try {
        sseWrite(res, { error: `upstream unavailable: ${err.code || err.message}` });
        res.write("data: [DONE]\n\n"); res.end();
      } catch {}
      resolve();
    });
    proxy.write(body); proxy.end();
  });
}

const server = http.createServer(async (req, res) => {
  if (req.method === "GET" && req.url === "/healthz") {
    res.writeHead(200); return res.end("ok\n");
  }

  // /warmup — idempotent "ensure the user's sandbox is provisioned and
  // bound" for the sign-in path, so the pod is ready by first question.
  if (req.method === "POST" && req.url === "/warmup") {
    const sub = extractUserSub(req);
    if (!sub) {
      res.writeHead(401, { "Content-Type": "application/json" });
      return res.end(JSON.stringify({ error: "no authenticated user" }));
    }
    if (READ_ONLY) {
      res.writeHead(200, { "Content-Type": "application/json" });
      return res.end(JSON.stringify({ status: "skipped", reason: "router in read-only mode" }));
    }
    const suffix = userSuffix(sub);
    try {
      await ensureClaim(suffix, sub);
      const bound = await waitForBoundSandbox(suffix, SANDBOX_READY_TIMEOUT_MS);
      if (!bound) {
        res.writeHead(504, { "Content-Type": "application/json" });
        return res.end(JSON.stringify({ status: "timeout", claim: claimName(suffix) }));
      }
      res.writeHead(200, { "Content-Type": "application/json" });
      return res.end(JSON.stringify({ status: "ready", sandbox: bound.sandboxName }));
    } catch (e) {
      const detail = e?.message || String(e);
      console.error("[router/warmup]", detail);
      const friendly = /HTTP request failed|ECONN|ETIMEDOUT|EAI_AGAIN/i.test(detail)
        ? "Could not reach your workspace — please retry in a moment."
        : `Could not start your session: ${detail}`;
      res.writeHead(502, { "Content-Type": "application/json" });
      return res.end(JSON.stringify({ error: friendly }));
    }
  }

  if (req.method !== "POST" || req.url !== "/chat") {
    res.writeHead(404); return res.end();
  }

  // Buffer the body up-front so both extractUserSub() and the downstream
  // proxy can use it. http.IncomingMessage is a one-shot readable.
  const bodyChunks = [];
  for await (const chunk of req) bodyChunks.push(chunk);
  const bodyBuf = Buffer.concat(bodyChunks);

  // Smoke-test mode: pass-through to the legacy shared sandbox.
  if (READ_ONLY) {
    res.writeHead(200, {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache, no-transform",
      "Connection": "keep-alive",
      "X-Accel-Buffering": "no",
    });
    await proxyChat(res, LEGACY_BACKEND, "legacy", bodyBuf);
    return;
  }

  const sub = extractUserSub(req);
  if (!sub) {
    res.writeHead(401, { "Content-Type": "application/json" });
    return res.end(JSON.stringify({ error: "no authenticated user" }));
  }

  const suffix = userSuffix(sub);
  res.writeHead(200, {
    "Content-Type": "text/event-stream",
    "Cache-Control": "no-cache, no-transform",
    "Connection": "keep-alive",
    "X-Accel-Buffering": "no",
  });
  const heartbeat = setInterval(() => { try { res.write(": ping\n\n"); } catch {} }, 10000);

  try {
    sseWrite(res, { status: "provisioning" });
    await ensureClaim(suffix, sub);
    const bound = await waitForBoundSandbox(suffix, SANDBOX_READY_TIMEOUT_MS);
    if (!bound) {
      clearInterval(heartbeat);
      sseWrite(res, { error: "sandbox not ready within timeout" });
      res.write("data: [DONE]\n\n"); return res.end();
    }
    sseWrite(res, { status: "ready" });
    clearInterval(heartbeat);
    await proxyChat(res, bound.fqdn, suffix, bodyBuf);
  } catch (e) {
    clearInterval(heartbeat);
    const detail = e?.message || String(e);
    console.error("[router]", detail);
    const friendly = /HTTP request failed|ECONN|ETIMEDOUT|EAI_AGAIN/i.test(detail)
      ? "Could not reach your workspace — please retry in a moment."
      : `Could not start your session: ${detail}`;
    try {
      sseWrite(res, { error: friendly });
      res.write("data: [DONE]\n\n"); res.end();
    } catch {}
  }
});

server.listen(PORT, "0.0.0.0", () => {
  console.log(`[router] listening on :${PORT} (ns=${NAMESPACE}, pool=${WARM_POOL}, idle_ttl=${IDLE_TTL_SECONDS}s)`);
});
