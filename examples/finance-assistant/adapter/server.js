// Adapter sidecar: translates the UI's OpenAI-style /chat SSE into openclaw
// CLI calls against the warm local gateway. Runs inside the sandbox pod,
// next to the openclaw gateway container, in the same Kata VM.
//
// Endpoints:
//   GET  /healthz                          -> liveness
//   POST /chat  {message, sessionId, suffix} -> SSE stream of the reply text
//
// Per-user isolation: the session-router passes the authenticated user's
// `suffix` in the body. On the first interaction for a suffix we provision
// a dedicated openclaw agent rooted at /workspace/users/<suffix> (a subdir
// on the shared EFS volume), then target it with `openclaw agent --agent
// pod-agent-<suffix>`. This keeps the pod spec identical across all warm
// pods (required for warm-bind) while giving each user durable, isolated
// workspace files that survive sandbox teardown.

// Redact first thing — catches every subsequent console.log/error that
// might touch a secret-shaped string. File-mounted secrets (below) are
// the primary defense; this is defense-in-depth.
require("./log-redact").install();

const http = require("http");
const fs = require("fs");
const { spawn } = require("child_process");

const PORT = parseInt(process.env.PORT || "18790", 10);
const OPENCLAW_CMD = process.env.OPENCLAW_CMD || "openclaw";
// The gateway reads its config/agents from /home/node/.openclaw (a shared
// emptyDir mounted in both containers). `agents add` and `agent --agent`
// MUST run with this HOME so the add lands in the config the running
// gateway hot-reloads — otherwise --agent silently falls back to the
// shared `main` agent and per-user routing breaks.
const OPENCLAW_HOME = process.env.OPENCLAW_HOME || "/home/node";
const rawArgs = process.env.OPENCLAW_ARGS || "";
const OPENCLAW_ARGS = rawArgs.trim() ? rawArgs.trim().split(/\s+/) : [];
// 15 min. Cold-start on a fresh per-user sandbox installs openclaw's
// bundled plugins (amazon-bedrock SDK, acpx, etc.) before the first
// response; that can take 60-120s on top of normal LLM time. Short
// timeouts truncate the response and make the UI look frozen.
const DEFAULT_TIMEOUT_MS = parseInt(process.env.ADAPTER_TIMEOUT_MS || "900000", 10);
// Shared EFS root; each user gets /workspace/users/<suffix>.
const WORKSPACE_ROOT = process.env.WORKSPACE_DIR || "/workspace";
// Suffix is a 10-hex-char hash from the router. Validate defensively so it
// can never escape the users/ dir or inject shell/flag args.
const SUFFIX_RE = /^[a-z0-9]{1,32}$/;

// Secrets are mounted as tmpfs files at /var/run/openclaw/*.
// We read them into locals at startup, then drop the env var (if any)
// so a downstream `env` dump cannot leak the value. The openclaw CLI
// still reads its config from ~/.openclaw/openclaw.json where the gateway
// container has already substituted these values in.
function readSecretFile(path) {
  try { return fs.readFileSync(path, "utf8").trim(); } catch { return ""; }
}
const LITELLM_API_KEY = readSecretFile("/var/run/openclaw/litellm-api-key") || process.env.LITELLM_API_KEY || "";
const GATEWAY_AUTH_TOKEN = readSecretFile("/var/run/openclaw/gateway-auth-token") || process.env.GATEWAY_AUTH_TOKEN || "";
// Strip from env so child processes can't inherit them.
delete process.env.LITELLM_API_KEY;
delete process.env.GATEWAY_AUTH_TOKEN;

function agentId(suffix) { return `pod-agent-${suffix}`; }
function userWorkspace(suffix) { return `${WORKSPACE_ROOT}/users/${suffix}`; }

// Per-user agent provisioning is idempotent + deduped. `provisioned`
// caches suffixes already added this gateway lifetime; `inflight` shares
// one promise so two concurrent first-hits don't double-add.
const provisioned = new Set();
const inflight = new Map();

// Provision (or heal) the user's openclaw agent. Pre-creating the workspace
// dir makes `agents add`'s own mkdir a no-op — sidestepping its non-atomic
// config-then-mkdir behavior and any uid/permission surprise on EFS.
function provisionAgent(suffix) {
  return new Promise((resolve, reject) => {
    const ws = userWorkspace(suffix);
    try { fs.mkdirSync(ws, { recursive: true }); }
    catch (e) { return reject(new Error(`workspace mkdir failed: ${e.message}`)); }
    const args = [...OPENCLAW_ARGS, "agents", "add", agentId(suffix),
      "--workspace", ws, "--non-interactive"];
    const child = spawn(OPENCLAW_CMD, args, {
      env: { PATH: process.env.PATH, HOME: OPENCLAW_HOME, NODE_ENV: process.env.NODE_ENV || "production" },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let out = "";
    child.stdout.on("data", (d) => { out += d.toString(); });
    child.stderr.on("data", (d) => { out += d.toString(); });
    child.on("close", (code) => {
      // Idempotent: a re-add of an existing agent is success. `agents add`
      // exits 0 in that case and prints "already exists".
      if (code === 0 || /already exists/i.test(out)) return resolve();
      console.error(`[adapter] agents add exit ${code}: ${out.slice(0, 300)}`);
      reject(new Error(`agents add failed (exit ${code})`));
    });
  });
}

function ensureAgent(suffix) {
  if (provisioned.has(suffix)) return Promise.resolve();
  const existing = inflight.get(suffix);
  if (existing) return existing;
  const p = provisionAgent(suffix)
    .then(() => { provisioned.add(suffix); })
    .finally(() => { inflight.delete(suffix); });
  inflight.set(suffix, p);
  return p;
}

function runOpenclaw(sessionId, message, suffix) {
  return new Promise((resolve, reject) => {
    // No --local: call the already-warm gateway instead of cold-starting
    // a fresh agent process per turn. --agent targets the user's agent
    // (overrides routing bindings), so the turn reads/writes that user's
    // workspace subdir.
    const args = [...OPENCLAW_ARGS, "agent"];
    if (suffix) args.push("--agent", agentId(suffix));
    args.push("--session-id", sessionId, "--thinking", "off", "--json", "-m", message);
    const child = spawn(OPENCLAW_CMD, args, {
      // Minimal env: only what the openclaw CLI actually needs. Secrets
      // are deliberately excluded — the CLI reads them from its config
      // file the gateway container wrote.
      env: {
        PATH: process.env.PATH,
        HOME: OPENCLAW_HOME,
        NODE_ENV: process.env.NODE_ENV || "production",
      },
      stdio: ["ignore", "pipe", "pipe"],
    });

    let stdout = "";
    let stderr = "";
    const timer = setTimeout(() => {
      child.kill("SIGTERM");
      reject(new Error(`openclaw timeout after ${DEFAULT_TIMEOUT_MS}ms`));
    }, DEFAULT_TIMEOUT_MS);

    child.stdout.on("data", (d) => { stdout += d.toString(); });
    child.stderr.on("data", (d) => { stderr += d.toString(); });
    child.on("close", (code) => {
      clearTimeout(timer);
      const candidates = [stdout, stderr];
      for (const src of candidates) {
        const jsonStart = src.indexOf("{\n");
        if (jsonStart < 0) continue;
        try {
          const parsed = JSON.parse(src.slice(jsonStart));
          const payloads = parsed?.result?.payloads ?? parsed?.payloads;
          if (!payloads) continue;
          // A multi-step agentic turn (tool calls, self-correction)
          // returns ONE payload per text segment. Concatenate them all —
          // reading only payloads[0] drops everything after the first
          // block and truncates the reply.
          const text = (Array.isArray(payloads) ? payloads : [payloads])
            .map((pl) => pl?.text ?? "")
            .filter(Boolean)
            .join("\n\n");
          const stopReason = parsed?.result?.meta?.stopReason
            ?? parsed?.meta?.stopReason
            ?? parsed?.status
            ?? "unknown";
          return resolve({ text, stopReason, parsed });
        } catch { continue; }
      }
      console.error(`[adapter] openclaw exit ${code}`);
      console.error(`[adapter] stdout(${stdout.length}):`, stdout.slice(0, 500));
      console.error(`[adapter] stderr(${stderr.length}):`, stderr.slice(0, 500));
      reject(new Error(`openclaw exit ${code}; stdout=${stdout.length}B stderr=${stderr.length}B`));
    });
  });
}

function sseWrite(res, data) {
  res.write(`data: ${JSON.stringify(data)}\n\n`);
}

async function streamReplyAsSse(res, text) {
  // openclaw currently returns the whole reply synchronously, so there is
  // no token stream to forward. Emit the full text as one SSE delta — the
  // previous code chopped it into 6-char chunks with 12ms sleeps between
  // them, which added ~2s of pointless latency *after* the model was done.
  // True per-token streaming is a follow-up (needs the openclaw WS client).
  sseWrite(res, { delta: text });
  sseWrite(res, { done: true });
  res.write("data: [DONE]\n\n");
  res.end();
}

const server = http.createServer(async (req, res) => {
  if (req.method === "GET" && req.url === "/healthz") {
    res.writeHead(200, { "Content-Type": "text/plain" });
    return res.end("ok\n");
  }

  if (req.method === "POST" && req.url === "/chat") {
    let body = "";
    req.on("data", (c) => { body += c; });
    req.on("end", async () => {
      let heartbeat;
      try {
        const { message, sessionId = "web", suffix } = JSON.parse(body || "{}");
        if (!message || typeof message !== "string") {
          res.writeHead(400, { "Content-Type": "application/json" });
          return res.end(JSON.stringify({ error: "message required" }));
        }
        // A valid suffix routes to the user's dedicated agent. Absent or
        // malformed (e.g. legacy/smoke path) falls back to the default agent.
        const useSuffix = typeof suffix === "string" && SUFFIX_RE.test(suffix) ? suffix : null;

        res.writeHead(200, {
          "Content-Type": "text/event-stream",
          "Cache-Control": "no-cache, no-transform",
          "Connection": "keep-alive",
          "X-Accel-Buffering": "no",
        });
        sseWrite(res, { status: "thinking" });
        heartbeat = setInterval(() => {
          try { res.write(": ping\n\n"); } catch {}
        }, 10000);

        // Provision the per-user agent on first interaction (idempotent).
        if (useSuffix) await ensureAgent(useSuffix);

        const { text, stopReason } = await runOpenclaw(sessionId, message, useSuffix);
        clearInterval(heartbeat);
        if (stopReason === "error" || !text) {
          sseWrite(res, { error: text || "agent error", stopReason });
          res.write("data: [DONE]\n\n");
          return res.end();
        }
        await streamReplyAsSse(res, text);
      } catch (e) {
        clearInterval(heartbeat);
        console.error("[adapter] error:", e.message);
        try {
          sseWrite(res, { error: e.message });
          res.write("data: [DONE]\n\n");
          res.end();
        } catch {}
      }
    });
    return;
  }

  res.writeHead(404);
  res.end();
});

server.listen(PORT, "0.0.0.0", () => {
  console.log(`[adapter] listening on :${PORT}`);
});
