#!/usr/bin/env node

const http = require("http");
const { loadModelList, resolveApiKey, KEY_MAP } = require("./lib/config");
const { httpRequest } = require("./lib/http");

const PORT = process.env.PORT || 8367;
const MODELS = loadModelList();

// ── Provider registry ──
const PROVIDERS = {};
function getProvider(name) {
  if (PROVIDERS[name]) return PROVIDERS[name];
  if (!KEY_MAP.hasOwnProperty(name)) throw new Error(`Unknown provider: "${name}"`);
  PROVIDERS[name] = require(`./providers/${name}`);
  return PROVIDERS[name];
}

// ── Metrics (simple in-memory, zero dependencies) ──
const startedAt = Date.now();
const metrics = {
  totalRequests: 0,
  totalErrors: 0,
  models: {},
};

for (const { provider, model } of MODELS) {
  const key = `${provider}:${model}`;
  metrics.models[key] = { attempts: 0, failed: 0, served: 0, totalMs: 0, avgMs: 0 };
}

function bumpAttempt(key) { metrics.models[key].attempts++; }
function bumpFailed(key) { metrics.models[key].failed++; }
function bumpServed(key, ms) {
  const m = metrics.models[key];
  m.served++;
  m.totalMs += ms;
  m.avgMs = Math.round(m.totalMs / m.served);
}

// ── Metrics formatting ──
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
      `proxy_model_attempts_total{model="${safe}"} ${d.attempts}`,
      `proxy_model_failures_total{model="${safe}"} ${d.failed}`,
      `proxy_model_served_total{model="${safe}"} ${d.served}`,
      `proxy_model_avg_ms{model="${safe}"} ${d.avgMs}`,
    );
  }

  lines.push("", `# proxy_uptime_seconds ${(Date.now() - startedAt) / 1000}`, "");
  return lines.join("\n");
}

// ── Body buffering ──
const MAX_BODY_BYTES = 10 * 1024 * 1024; // 10 MB

function bufferBody(stream) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let totalBytes = 0;
    let settled = false;

    stream.on("data", (chunk) => {
      if (settled) return;
      totalBytes += chunk.length;
      if (totalBytes > MAX_BODY_BYTES) {
        settled = true;
        stream.resume(); // drain without storing; keeps socket open to send 413
        const err = new Error("Payload too large");
        err.statusCode = 413;
        reject(err);
        return;
      }
      chunks.push(chunk);
    });

    stream.on("error", (err) => { if (!settled) { settled = true; reject(err); } });
    stream.on("end",   ()    => { if (!settled) { settled = true; resolve(Buffer.concat(chunks)); } });
  });
}

// ── Forward headers from client (for OpenAI-compat providers that accept them) ──
function pickClientHeaders(clientHeaders) {
  const h = {};
  for (const k of ["user-agent", "http-referer"]) {
    if (clientHeaders[k]) h[k] = clientHeaders[k];
  }
  return h;
}

// ── HTTP server ──
const server = http.createServer(async (req, res) => {
  const reqUrl = new URL(req.url, `http://127.0.0.1:${PORT}`);

  // Health check
  if (req.method === "GET" && (reqUrl.pathname === "/health" || reqUrl.pathname === "/ready")) {
    const providers = [...new Set(MODELS.map((m) => m.provider))];
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({
      status: "ok",
      uptime: process.uptime(),
      models: MODELS.length,
      providers,
    }));
    return;
  }

  // Metrics
  if (req.method === "GET" && reqUrl.pathname === "/metrics") {
    res.writeHead(200, { "content-type": "text/plain; version=0.0.4" });
    res.end(formatMetrics());
    return;
  }

  metrics.totalRequests++;

  try {
    const raw = await bufferBody(req);
    let body = {};
    if (raw.length > 0) {
      try {
        body = JSON.parse(raw.toString("utf8"));
      } catch {
        res.writeHead(400, { "content-type": "application/json" });
        res.end(JSON.stringify({ error: { message: "Invalid JSON body", code: 400 } }));
        return;
      }
    }
    const isStream = body.stream === true;
    const failures = [];

    // Remove model from body — each provider sets its own
    delete body.model;

    for (const { provider: providerName, model } of MODELS) {
      const metricsKey = `${providerName}:${model}`;
      const t0 = Date.now();
      bumpAttempt(metricsKey);

      try {
        const provider = getProvider(providerName);
        const apiKey = resolveApiKey(providerName);
        const { url, headers, body: bodyStr } = provider.buildRequest(body, model, apiKey);

        // Merge useful client headers
        const clientH = pickClientHeaders(req.headers);
        const mergedHeaders = { ...headers, ...clientH };

        if (isStream) {
          const upstreamRes = await httpRequest(url, mergedHeaders, bodyStr, { stream: true });
          const ms = Date.now() - t0;
          bumpServed(metricsKey, ms);
          provider.transformStream(upstreamRes, res);
          return;
        }

        const { status, body: respBody } = await httpRequest(
          url, mergedHeaders, bodyStr, { stream: false }
        );
        const ms = Date.now() - t0;

        if (status >= 500 || status === 429) {
          bumpFailed(metricsKey);
          failures.push(`${metricsKey} (${status})`);
          continue;
        }

        bumpServed(metricsKey, ms);
        const adapted = provider.parseResponse(respBody);
        res.writeHead(status, { "content-type": "application/json" });
        res.end(JSON.stringify(adapted));
        return;
      } catch (err) {
        bumpFailed(metricsKey);
        failures.push(`${metricsKey} (${err.message})`);
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
    const code = err.statusCode || 500;
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
  const providers = [...new Set(MODELS.map((m) => m.provider))];
  const chain = MODELS.map((m) => `${m.provider}:${m.model}`).join(" \u2192 ");
  console.log(`model-chain-proxy listening on http://127.0.0.1:${PORT}`);
  console.log(`  providers: ${providers.join(", ")}`);
  console.log(`  chain    : ${chain}`);
});
