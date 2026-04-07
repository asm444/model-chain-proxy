# model-chain-proxy

A lightweight HTTP proxy for OpenRouter that automatically tries a chain of models in order, falling back to the next one when a request fails.

## How it works

```
Client  →  localhost:8367  →  try model 1
                              502/429/timeout? → try model 2
                              still failing?   → try model 3
                              all exhausted?   → 503 error
```

## Configuration

All settings are optional — the proxy has sensible defaults.

### Environment variables

| Variable | Default | Purpose |
|---|---|---|
| `PORT` | `8367` | Local listen port |
| `UPSTREAM_BASE_URL` | `https://openrouter.ai/api/v1` | API endpoint to forward to |
| `MODELS` | `qwen/qwen3.6-plus:free,nvidia/nemotron-3-super-120b-a12b:free,minimax/minimax-m2.5:free` | Comma-separated fallback chain |
| `FALLBACK_API_KEY` | — | OpenRouter API key (checked first) |
| `OPENAI_API_KEY` | — | OpenRouter API key (checked second) |
| `ANTHROPIC_API_KEY` | — | OpenRouter API key (checked third) |

### API key resolution

The proxy looks for an API key in this order:

1. Client `Authorization: Bearer ...` header (if present, no override)
2. `FALLBACK_API_KEY` environment variable
3. Shell session variables (sourced from your `.zshrc` / `.bashrc`)
4. `OPENAI_API_KEY` environment variable
5. `ANTHROPIC_API_KEY` / `OPENROUTER_API_KEY` environment variables

To have the proxy automatically pick up your key, add it to your shell config:

```bash
# ~/.zshrc
export OPENROUTER_API_KEY="your-api-key-here"
```

The proxy will source this from a login shell if the variable isn't already in its inherited environment.

### Models

Define your fallback chain:

```bash
export MODELS="qwen/qwen3.6-plus:free,google/gemini-2.0-flash:free,meta-llama/llama-3-3-70b-instruct:free"
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

## Using with OpenClaude

Point your `OPENAI_BASE_URL` to the proxy:

```bash
export OPENAI_BASE_URL=http://127.0.0.1:8367
```

## Monitoring

### `/health`

Returns service status:

```bash
curl http://127.0.0.1:8367/health
# {"status":"ok","uptime":123.4,"models":3,"upstream":"https://openrouter.ai"}
```

### `/metrics`

Prometheus-style plain text metrics:

```bash
curl http://127.0.0.1:8367/metrics
```

Exposed metrics:

| Metric | What it tells you |
|---|---|
| `proxy_model_attempts_total` | How often each model was tried |
| `proxy_model_failures_total` | How often each model failed |
| `proxy_model_served_total` | How many requests each model actually fulfilled |
| `proxy_model_avg_ms` | Average latency per model (when it succeeded) |
| `proxy_requests_total` | Total client requests received |
| `proxy_errors_total` | Total 503 responses (entire chain failed) |

Use these to decide: if a model has high `attempts` but low `served`, it's dead weight. If latency is high, consider reordering the chain.

## Fallback behavior

- Non-streaming requests: tries each model synchronously on `5xx`, `429`, or connection error — `4xx` responses (auth, bad request) are returned as-is.
- Streaming requests: attempts the first available model. On stream error, the chain is not retried to avoid broken SSE to the client.
- If every model fails: returns `503` with a list of which models failed and why.

## Requirements

- Node.js 18+
- No npm dependencies
