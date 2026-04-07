#!/usr/bin/env node

const http = require("http");
const https = require("https");
const fs = require("fs");
const path = require("path");
const { execFileSync } = require("child_process");

const PORT = process.env.PORT || 8367;
const UPSTREAM = new URL(process.env.UPSTREAM_BASE_URL || "https://openrouter.ai/api/v1");
const UPSTREAM_AGENT = new https.Agent({ keepAlive: true });
const MODELS = process.env.MODELS
  ? process.env.MODELS.split(",").map((s) => s.trim()).filter(Boolean)
  : loadModels(path.join(__dirname, "models.list"));

const AUTH_SOURCES = ["FALLBACK_API_KEY", "OPENAI_API_KEY", "ANTHROPIC_API_KEY", "OPENROUTER_API_KEY"];

// ── Metrics (simple in-memory, zero dependencies) ──
const startedAt = Date.now();
const metrics = {
  totalRequests: 0,
  totalErrors: 0,
  models: {},
};

function initMetrics() {
  for (const m of MODELS) {
    metrics.models[m] = { attempts: 0, failed: 0, served: 0, totalMs: 0 };
  }
}

function bumpAttempt(model) { metrics.models[model].attempts++; }
function bumpFailed(model) { metrics.models[model].failed++; }
function bumpServed(model, ms) {
  metrics.models[model].served++;
  metrics.models[model].totalMs += ms;
  metrics.models[model].avgMs = Math.round(metrics.models[model].totalMs / metrics.models[model].served);
}

initMetrics();

// ── Lazy-resolved API key ──
let _resolvedKey = undefined;
function resolveApiKey() {
  if (_resolvedKey !== undefined) return _resolvedKey;

  for (const key of AUTH_SOURCES) {
    let val = process.env[key];
    if (!val) {
      try {
        val = execFileSync("bash", ["-lc", `echo -n $${key}`], {
          timeout: 3000,
          env: { PATH: process.env.PATH, HOME: process.env.HOME, USER: process.env.USER },
        }).toString();
      } catch {
        val = "";
      }
    }
    if (val) { _resolvedKey = val; return val; }
  }

  _resolvedKey = null;
  return null;
}

function loadModels(file) {
  const models = fs.readFileSync(file, "utf8").trim()
    .split("\n")
    .map((l) => l.trim())
    .filter((l) => l && !l.startsWith("#"));

  if (models.length === 0) throw new Error("No models configured in models.list");
  return models;
}

function buildHeaders(clientHeaders, bodyStr) {
  const h = {
    "content-type": "application/json",
    "content-length": Buffer.byteLength(bodyStr),
    host: UPSTREAM.hostname,
  };

  for (const k of ["authorization", "cookie", "user-agent", "http-referer"]) {
    if (clientHeaders[k]) h[k] = clientHeaders[k];
  }

  if (!clientHeaders.authorization?.startsWith("Bearer ")) {
    const token = resolveApiKey();
    if (token) h.authorization = `Bearer ${token}`;
  }

  return h;
}

function request(model, apiPath, method, headers, body, stream) {
  return new Promise((resolve, reject) => {
    const payload = JSON.stringify({ ...body, model, stream });

    const req = https.request({
      hostname: UPSTREAM.hostname,
      port: UPSTREAM.port || 443,
      path: UPSTREAM.pathname + apiPath,
      method,
      headers: buildHeaders(headers, payload),
      agent: UPSTREAM_AGENT,
      timeout: stream ? 90000 : 60000,
    }, (res) => {
      if (stream && res.statusCode >= 400) {
        const chunks = [];
        res.on("data", (c) => chunks.push(c));
        res.on("end", () => {
          const msg = chunks.length ? chunks.join("") : `upstream returned ${res.statusCode}`;
          reject(new Error(`model error ${res.statusCode}: ${String(msg).slice(0, 200)}`));
        });
        return;
      }
      if (stream) {
        resolve(res);
        return;
      }
      const chunks = [];
      res.on("data", (c) => chunks.push(c));
      res.on("end", () => resolve({ status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks) }));
    });

    req.on("timeout", () => { req.destroy(); reject(new Error("timeout")); });
    req.on("error", reject);
    req.end(payload);
  });
}

function bufferBody(stream) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    stream.on("data", (c) => chunks.push(c));
    stream.on("error", reject);
    stream.on("end", () => resolve(Buffer.concat(chunks)));
  });
}

function formatMetrics() {
  const lines = [
    "# HELP proxy_requests_total Total client requests received",
    "# TYPE proxy_requests_total counter",
    `proxy_requests_total ${metrics.totalRequests}`,
    "",
    "# HELP proxy_errors_total Total 503 responses (all models failed)",
    "# TYPE proxy_errors_total counter",
    `proxy_errors_total ${metrics.totalErrors}`,
  ];

  for (const [name, d] of Object.entries(metrics.models)) {
    const safe = name.replace(/[{}"=]/g, "_");
    lines.push(
      "",
      `# HELP proxy_model_attempts_total How many times a model was tried (including fallbacks)`,
      `# TYPE proxy_model_attempts_total counter`,
      `proxy_model_attempts_total{model="${safe}"} ${d.attempts}`,
      "",
      `# HELP proxy_model_failures_total How many times a model failed`,
      `# TYPE proxy_model_failures_total counter`,
      `proxy_model_failures_total{model="${safe}"} ${d.failed}`,
      "",
      `# HELP proxy_model_served_total How many requests this model successfully served`,
      `# TYPE proxy_model_served_total counter`,
      `proxy_model_served_total{model="${safe}"} ${d.served}`,
      "",
      `# HELP proxy_model_avg_ms Average response time in milliseconds when served`,
      `# TYPE proxy_model_avg_ms gauge`,
      `proxy_model_avg_ms{model="${safe}"} ${d.avgMs ?? 0}`,
    );
  }

  lines.push("", `# proxy_uptime_seconds ${(Date.now() - startedAt) / 1000}`, "");
  return lines.join("\n");
}

const server = http.createServer(async (req, res) => {
  const reqUrl = new URL(req.url, `http://127.0.0.1:${PORT}`);

  if (req.method === "GET" && (reqUrl.pathname === "/health" || reqUrl.pathname === "/ready")) {
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({
      status: "ok",
      uptime: process.uptime(),
      models: MODELS.length,
      upstream: UPSTREAM.origin,
    }));
    return;
  }

  if (req.method === "GET" && reqUrl.pathname === "/metrics") {
    res.writeHead(200, { "content-type": "text/plain; version=0.0.4" });
    res.end(formatMetrics());
    return;
  }

  metrics.totalRequests++;

  let apiPath = reqUrl.pathname;
  if (apiPath.startsWith("/v1")) apiPath = apiPath.slice(3);

  try {
    const raw = await bufferBody(req);
    const body = raw.length > 0 ? JSON.parse(raw.toString()) : {};
    const isStream = body.stream === true;
    const failures = [];

    for (const model of MODELS) {
      const t0 = Date.now();
      bumpAttempt(model);

      try {
        if (isStream) {
          const upstreamRes = await request(model, apiPath, req.method, req.headers, body, true);
          const ms = Date.now() - t0;
          bumpServed(model, ms);
          res.writeHead(upstreamRes.statusCode, {
            "content-type": upstreamRes.headers["content-type"] || "text/event-stream",
            "cache-control": "no-cache",
            connection: "keep-alive",
          });
          upstreamRes.on("aborted", () => { if (!res.writableEnded) res.end(); });
          upstreamRes.on("error", () => { if (!res.writableEnded) res.end(); });
          upstreamRes.pipe(res);
          return;
        }

        const { status, headers, body: respBody } = await request(
          model, apiPath, req.method, req.headers, body, false
        );
        const ms = Date.now() - t0;

        if (status >= 500 || status === 429) {
          bumpFailed(model);
          failures.push(`${model} (${status})`);
          continue;
        }

        bumpServed(model, ms);
        res.writeHead(status, { "content-type": headers["content-type"] || "application/json" });
        res.end(respBody);
        return;
      } catch (err) {
        bumpFailed(model);
        failures.push(`${model} (${err.message})`);
      }
    }

    if (!res.headersSent) {
      metrics.totalErrors++;
      res.writeHead(503, { "content-type": "application/json" });
      res.end(JSON.stringify({
        error: {
          message: `All models in the fallback chain failed. Attempted: ${failures.join("; ")}`,
          code: 503,
        },
      }));
    }
  } catch (err) {
    // Only JSON parse errors are client errors (400); everything else is 500
    const code = err instanceof SyntaxError || (err.message?.includes("Unexpected token")) ? 400 : 500;
    if (!res.headersSent) {
      res.writeHead(code, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: { message: err.message, code } }));
    }
  }
});

server.on("error", (e) => {
  if (e.code === "EADDRINUSE") {
    console.error(`port ${PORT} is already in use`);
    process.exit(1);
  }
});

server.listen(PORT, "127.0.0.1", () => {
  console.log(`model-chain-proxy listening on http://127.0.0.1:${PORT}`);
  console.log(`  upstream : ${UPSTREAM.origin}`);
  console.log(`  models   : ${MODELS.join(" \u2192 ")}`);
});
