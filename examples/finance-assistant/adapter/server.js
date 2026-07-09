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
// The warm gateway serves an OpenAI-compatible streaming endpoint at
// /v1/chat/completions (enabled via gateway.http.endpoints.chatCompletions
// in the SandboxTemplate config). We stream from it so tokens reach the
// browser as they're produced instead of buffering the whole reply. Same
// pod, same Kata VM — loopback is fine.
const GATEWAY_HOST = process.env.GATEWAY_HOST || "127.0.0.1";
const GATEWAY_PORT = parseInt(process.env.GATEWAY_PORT || "18789", 10);
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

// Stream a turn from the warm gateway's OpenAI-compatible endpoint. Each
// `choices[0].delta.content` chunk is handed to onDelta the instant it
// arrives, so the browser renders tokens live instead of waiting for the
// whole agentic loop. Targeting:
//   - x-openclaw-agent-id  -> the user's per-user agent (routing/isolation);
//     absent for the legacy/smoke path, which falls back to the default agent.
//   - x-openclaw-session-key `agent:<agentId>:<sessionId>` preserves the
//     server-side session continuity the CLI got from --agent + --session-id.
//   - Bearer <gateway-auth-token> — token auth = owner scope on this endpoint.
//     The token is read from the tmpfs secret file at startup (never an env var).
// Thinking is forced off via the config's agents.defaults.thinkingDefault
// (the endpoint has no per-request thinking control), matching the old
// --thinking off. Streamed chunks concatenate in arrival order, so the
// multi-segment reply that the buffered path had to join by hand assembles
// itself here — no truncation.
function runOpenclaw(sessionId, message, suffix, onDelta) {
  return new Promise((resolve, reject) => {
    const headers = {
      "Content-Type": "application/json",
      "Accept": "text/event-stream",
    };
    if (GATEWAY_AUTH_TOKEN) headers["Authorization"] = `Bearer ${GATEWAY_AUTH_TOKEN}`;
    if (suffix) {
      headers["x-openclaw-agent-id"] = agentId(suffix);
      headers["x-openclaw-session-key"] = `agent:${agentId(suffix)}:${sessionId}`;
    }
    const payload = JSON.stringify({
      model: "openclaw",
      stream: true,
      messages: [{ role: "user", content: message }],
    });

    const req = http.request(
      { host: GATEWAY_HOST, port: GATEWAY_PORT, path: "/v1/chat/completions", method: "POST", headers },
      (up) => {
        if (up.statusCode !== 200) {
          let body = "";
          up.on("data", (d) => { body += d.toString(); });
          up.on("end", () => reject(new Error(`gateway ${up.statusCode}: ${body.slice(0, 300)}`)));
          return;
        }
        let buf = "";
        let text = "";
        let stopReason = "unknown";
        up.setEncoding("utf8");
        up.on("data", (chunk) => {
          buf += chunk;
          let idx;
          // SSE frames are `\n\n`-delimited; keep any partial trailing frame.
          while ((idx = buf.indexOf("\n\n")) >= 0) {
            const frame = buf.slice(0, idx);
            buf = buf.slice(idx + 2);
            const line = frame.trim();
            if (!line.startsWith("data:")) continue;
            const data = line.slice(5).trim();
            if (data === "[DONE]") continue;
            try {
              const evt = JSON.parse(data);
              const choice = evt?.choices?.[0];
              const piece = choice?.delta?.content;
              if (piece) {
                text += piece;
                try { onDelta?.(piece); } catch {}
              }
              if (choice?.finish_reason) stopReason = choice.finish_reason;
              if (evt?.error) {
                stopReason = "error";
                text = text || (evt.error.message ?? String(evt.error));
              }
            } catch { /* ignore keep-alive comments / partial frames */ }
          }
        });
        up.on("end", () => {
          clearTimeout(timer);
          resolve({ text, stopReason });
        });
        up.on("error", (e) => { clearTimeout(timer); reject(e); });
      },
    );

    const timer = setTimeout(() => {
      req.destroy(new Error(`gateway stream timeout after ${DEFAULT_TIMEOUT_MS}ms`));
    }, DEFAULT_TIMEOUT_MS);

    req.on("error", (e) => { clearTimeout(timer); reject(e); });
    req.write(payload);
    req.end();
  });
}

function sseWrite(res, data) {
  res.write(`data: ${JSON.stringify(data)}\n\n`);
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

        // Forward each token the instant it arrives. The heartbeat keeps
        // the ALB stream alive across the initial pre-first-token gap (the
        // Bedrock round-trips); once tokens flow they keep it alive too, and
        // the `: ping` comments the client ignores are harmless alongside deltas.
        let sentDelta = false;
        const { text, stopReason } = await runOpenclaw(sessionId, message, useSuffix, (piece) => {
          sentDelta = true;
          sseWrite(res, { delta: piece });
        });
        clearInterval(heartbeat);
        if (!sentDelta) {
          // Nothing streamed: an error or an empty reply. Preserve the old
          // one-shot behavior — surface the error, or emit any final text once.
          if (stopReason === "error" || !text) {
            sseWrite(res, { error: text || "agent error", stopReason });
            res.write("data: [DONE]\n\n");
            return res.end();
          }
          sseWrite(res, { delta: text });
        }
        sseWrite(res, { done: true });
        res.write("data: [DONE]\n\n");
        res.end();
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
