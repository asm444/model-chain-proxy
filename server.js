#!/usr/bin/env node

const http = require("http");
const { loadModelList, resolveApiKey } = require("./lib/config");
const { httpRequest, bufferBody, pickClientHeaders } = require("./lib/http");
const metrics = require("./lib/metrics");
const { getProvider } = require("./lib/registry");

const PORT = process.env.PORT || 8367;
const MODELS = loadModelList();

metrics.init(MODELS);

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
    res.end(metrics.format());
    return;
  }

  metrics.bumpRequest();

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
      metrics.bumpAttempt(metricsKey);

      try {
        const provider = getProvider(providerName);
        const apiKey = resolveApiKey(providerName);
        const { url, headers, body: bodyStr } = provider.buildRequest(body, model, apiKey);

        const mergedHeaders = { ...headers, ...pickClientHeaders(req.headers) };

        if (isStream) {
          const upstreamRes = await httpRequest(url, mergedHeaders, bodyStr, { stream: true });
          // Headers are committed inside transformStream — we cannot retry after this point.
          try {
            await provider.transformStream(upstreamRes, res);
            metrics.bumpServed(metricsKey, Date.now() - t0);
          } catch (streamErr) {
            metrics.bumpFailed(metricsKey);
            // Headers already sent — cannot retry. Log so the error is not silent.
            console.error(`[stream error] ${metricsKey}: ${streamErr.message}`);
          }
          return;
        }

        const { status, body: respBody } = await httpRequest(
          url, mergedHeaders, bodyStr, { stream: false }
        );
        const ms = Date.now() - t0;

        if (status >= 500 || status === 429) {
          metrics.bumpFailed(metricsKey);
          failures.push(`${metricsKey} (${status})`);
          continue;
        }

        metrics.bumpServed(metricsKey, ms);
        const adapted = provider.parseResponse(respBody);
        res.writeHead(status, { "content-type": "application/json" });
        res.end(JSON.stringify(adapted));
        return;
      } catch (err) {
        metrics.bumpFailed(metricsKey);
        failures.push(`${metricsKey} (${err.message})`);
      }
    }

    if (!res.headersSent) {
      metrics.bumpError();
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
