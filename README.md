# model-chain-proxy

A lightweight HTTP proxy for OpenRouter that automatically tries a chain of models in order, falling back to the next one when a request fails.

## How it works

```
Client  →  localhost:8367  →  try model 1
                              502/429/timeout? → try model 2
                              still failing?   → try model 3
                              all exhausted?   → 503 error
```

### Request flow

1. **Buffer** — the proxy reads the full client request body.
2. **Parse** — checks if `stream: true` in the JSON body.
3. **Fallback loop** — iterates through `models.list` (or `MODELS` env var), trying each model sequentially:
   - **Non-streaming**: full response is buffered. On `5xx`, `429`, or network error, the loop continues to the next model. `4xx` responses (auth errors, bad requests) are forwarded to the client immediately.
   - **Streaming**: the first model that accepts the connection gets its SSE stream piped directly to the client. No retry once piping starts — a broken SSE cannot be reconstructed mid-stream.
4. **All failed** → `503` with a detailed error listing every model attempted and the reason for failure.

### API key resolution

The proxy checks, in order, for an API key:

1. Client `Authorization: Bearer ...` header (respected, never overridden)
2. `FALLBACK_API_KEY` / `OPENAI_API_KEY` / `ANTHROPIC_API_KEY` / `OPENROUTER_API_KEY` env vars
3. Login shell sourcing (`bash -lc`) — picks up `export` from `.zshrc` / `.bashrc`

The result is cached on first resolution so every request has zero overhead on auth lookup.

### Model configuration

By default, the proxy reads the fallback chain from `models.list` — one model per line, `#` for comments. Edited at any time and reloaded on next restart:

```
qwen/qwen3.6-plus:free
nvidia/nemotron-3-super-120b-a12b:free
# fallback
minimax/minimax-m2.5:free
```

To override the file temporarily for a single run, set `MODELS`:

```bash
MODELS="qwen/qwen3.6-plus:free,google/gemini-2.0-flash:free" node server.js
```

## Configuration

All settings are optional — the proxy has sensible defaults.

### Environment variables

| Variable | Default | Purpose |
|---|---|---|
| `PORT` | `8367` | Local listen port |
| `UPSTREAM_BASE_URL` | `https://openrouter.ai/api/v1` | API endpoint to forward to |
| `MODELS` | _(see models.list)_ | Comma-separated fallback chain (overrides file, optional) |
| `FALLBACK_API_KEY` | — | OpenRouter API key (checked first) |
| `OPENAI_API_KEY` | — | OpenRouter API key (checked second) |
| `ANTHROPIC_API_KEY` | — | OpenRouter API key (checked third) |
| `OPENROUTER_API_KEY` | — | OpenRouter API key (checked fourth) |

### API key setup

To have the proxy pick up your key automatically from your shell config:

```bash
# ~/.zshrc
export OPENROUTER_API_KEY="your-api-key-here"
```

## Usage

```bash
# Direct
node server.js

# Custom config
MODELS="model-a,model-b" PORT=9000 node server.js

# As a systemd service
cp model-chain-proxy.service /etc/systemd/system/
systemctl daemon-reload
systemctl enable --now model-chain-proxy
```

### Using with OpenClaude

Point your `OPENAI_BASE_URL` to the proxy:

```bash
export OPENAI_BASE_URL=http://127.0.0.1:8367
```

## Monitoring

### `/health` and `/ready`

Returns service status (both paths are equivalent):

```bash
curl http://127.0.0.1:8367/health
# {"status":"ok","uptime":123.4,"models":3,"upstream":"https://openrouter.ai"}
```

### `/metrics`

Prometheus-style plain text metrics:

```bash
curl http://127.0.0.1:8367/metrics
```

| Metric | What it tells you |
|---|---|
| `proxy_requests_total` | Total client requests received |
| `proxy_errors_total` | Total 503 responses (entire chain failed) |
| `proxy_model_attempts_total{model="X"}` | How often model X was tried |
| `proxy_model_failures_total{model="X"}` | How often model X failed |
| `proxy_model_served_total{model="X"}` | How many requests model X fulfilled |
| `proxy_model_avg_ms{model="X"}` | Average latency of model X |

## Requirements

- Node.js 18+
- Zero npm dependencies
