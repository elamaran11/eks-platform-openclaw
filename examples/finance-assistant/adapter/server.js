// Adapter sidecar: translates OpenAI-style /chat/completions SSE
// into openclaw `agent --local` CLI calls. Runs inside the sandbox pod,
// next to the openclaw gateway container, in the same Kata VM.
//
// Endpoints:
//   GET  /healthz                 -> liveness
//   POST /chat  {message, sessionId}  -> SSE stream of the reply text
//
// System prompt lives at /etc/openclaw/system-prompt.md and is
// prepended to the user message on the first turn per session.

const http = require("http");
const { spawn } = require("child_process");
const fs = require("fs");

const PORT = parseInt(process.env.PORT || "18790", 10);
const OPENCLAW_CMD = process.env.OPENCLAW_CMD || "openclaw";
const rawArgs = process.env.OPENCLAW_ARGS || "";
const OPENCLAW_ARGS = rawArgs.trim() ? rawArgs.trim().split(/\s+/) : [];
const SYSTEM_PROMPT_FILE = process.env.SYSTEM_PROMPT_FILE || "/etc/openclaw/system-prompt.md";
const DEFAULT_TIMEOUT_MS = 300000;

let SYSTEM_PROMPT = "";
try {
  SYSTEM_PROMPT = fs.readFileSync(SYSTEM_PROMPT_FILE, "utf8").trim();
  console.log(`[adapter] loaded system prompt (${SYSTEM_PROMPT.length} chars)`);
} catch (e) {
  console.warn(`[adapter] no system prompt at ${SYSTEM_PROMPT_FILE}: ${e.message}`);
}

// Track which sessions have already received the system prompt injection
const primedSessions = new Set();

function runOpenclaw(sessionId, message) {
  return new Promise((resolve, reject) => {
    const args = [
      ...OPENCLAW_ARGS,
      "agent", "--local",
      "--session-id", sessionId,
      "--thinking", "off",
      "--json",
      "-m", message,
    ];
    const child = spawn(OPENCLAW_CMD, args, {
      env: { ...process.env },
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
      const combined = stdout + stderr;
      if (code !== 0 && !combined.includes('"payloads"')) {
        return reject(new Error(`openclaw exit ${code}: ${stderr.slice(0, 500)}`));
      }
      const jsonStart = combined.indexOf("{\n");
      if (jsonStart < 0) return reject(new Error(`no JSON: ${combined.slice(0, 300)}`));
      try {
        const parsed = JSON.parse(combined.slice(jsonStart));
        const text = parsed?.payloads?.[0]?.text ?? "";
        const stopReason = parsed?.meta?.stopReason ?? "unknown";
        resolve({ text, stopReason, parsed });
      } catch (e) {
        reject(new Error(`JSON parse failed: ${e.message}`));
      }
    });
  });
}

function sseWrite(res, data) {
  res.write(`data: ${JSON.stringify(data)}\n\n`);
}

async function streamReplyAsSse(res, text) {
  // Chunk the reply so the UI gets a typing effect. openclaw returns the
  // full text synchronously so true token streaming needs a protocol change.
  const chunks = text.match(/.{1,6}/gs) || [text];
  for (const c of chunks) {
    sseWrite(res, { delta: c });
    await new Promise((r) => setTimeout(r, 12));
  }
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
        const { message, sessionId = "web" } = JSON.parse(body || "{}");
        if (!message || typeof message !== "string") {
          res.writeHead(400, { "Content-Type": "application/json" });
          return res.end(JSON.stringify({ error: "message required" }));
        }

        let payload = message;
        if (SYSTEM_PROMPT && !primedSessions.has(sessionId)) {
          payload = `SYSTEM INSTRUCTIONS:\n${SYSTEM_PROMPT}\n\n---\n\nUSER:\n${message}`;
          primedSessions.add(sessionId);
        }

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

        const { text, stopReason } = await runOpenclaw(sessionId, payload);
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
