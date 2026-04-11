const startedAt = Date.now();

const state = {
  totalRequests: 0,
  totalErrors: 0,
  models: {},
};

// Must be called once at startup with the loaded model list.
function init(models) {
  for (const { provider, model } of models) {
    const key = `${provider}:${model}`;
    state.models[key] = { attempts: 0, failed: 0, served: 0, totalMs: 0, avgMs: 0 };
  }
}

function bumpRequest() { state.totalRequests++; }
function bumpError()   { state.totalErrors++; }
function bumpAttempt(key) { state.models[key].attempts++; }
function bumpFailed(key)  { state.models[key].failed++; }
function bumpServed(key, ms) {
  const m = state.models[key];
  m.served++;
  m.totalMs += ms;
  m.avgMs = Math.round(m.totalMs / m.served);
}

function format() {
  const lines = [
    "# HELP proxy_requests_total Total client requests received",
    "# TYPE proxy_requests_total counter",
    `proxy_requests_total ${state.totalRequests}`,
    "",
    "# HELP proxy_errors_total Total 503 responses (all models failed)",
    "# TYPE proxy_errors_total counter",
    `proxy_errors_total ${state.totalErrors}`,
  ];

  for (const [name, d] of Object.entries(state.models)) {
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

module.exports = { init, bumpRequest, bumpError, bumpAttempt, bumpFailed, bumpServed, format };
