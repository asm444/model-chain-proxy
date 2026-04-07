# model-chain-proxy

A lightweight, zero-dependency HTTP proxy that chains multiple LLM providers with automatic fallback. Supports OpenAI, Anthropic, Google Gemini, Ollama, Mistral, xAI (Grok), and OpenRouter.

## How it works

```
Client (OpenAI format) → localhost:8367 → try provider:model 1
                                          5xx/429/timeout? → try provider:model 2
                                          still failing?   → try provider:model 3
                                          all exhausted?   → 503 error
```

The proxy accepts requests in **OpenAI format** and automatically translates them to each provider's native API. Responses are translated back to OpenAI format, making the proxy transparent to any OpenAI-compatible client.

### Supported providers

| Provider | API Format | Streaming | Auth |
|---|---|---|---|
| **OpenAI** | Native | SSE | `Bearer` token |
| **Anthropic** | Translated | SSE (translated) | `x-api-key` header |
| **Google Gemini** | Translated | SSE (translated) | Query parameter |
| **Ollama** | OpenAI-compat | SSE | None (local) |
| **Mistral** | OpenAI-compat | SSE | `Bearer` token |
| **xAI (Grok)** | OpenAI-compat | SSE | `Bearer` token |
| **OpenRouter** | OpenAI-compat | SSE | `Bearer` token |

### Request flow

1. **Buffer** — reads the full client request body
2. **Parse** — detects `stream: true` in the JSON body
3. **Fallback loop** — iterates through the model chain:
   - Builds a provider-native request (URL, headers, body translation)
   - On success: translates response back to OpenAI format and returns
   - On `5xx`, `429`, or network error: tries the next model
   - On `4xx` (auth errors, bad requests): returns immediately
   - **Streaming**: SSE from non-OpenAI providers is translated on-the-fly
4. **All failed** → `503` with details of every model attempted

## Configuration

### Model chain (`models.list`)

One entry per line, format `provider:model`. Lines starting with `#` are comments.

```
# Primary
openai:gpt-4o
anthropic:claude-sonnet-4-20250514

# Fallback
gemini:gemini-2.0-flash
openrouter:qwen/qwen3-235b-a22b:free

# Local
ollama:llama3

# Others
mistral:mistral-large-latest
xai:grok-3
```

Override with `MODELS` env var (comma-separated):

```bash
MODELS="openai:gpt-4o,anthropic:claude-sonnet-4-20250514" node server.js
```

Entries **without a prefix** default to `openrouter` for backward compatibility:

```
qwen/qwen3-235b-a22b:free    # treated as openrouter:qwen/qwen3-235b-a22b:free
```

### Environment variables

| Variable | Default | Purpose |
|---|---|---|
| `PORT` | `8367` | Local listen port |
| `OPENAI_API_KEY` | — | OpenAI API key |
| `ANTHROPIC_API_KEY` | — | Anthropic API key |
| `GEMINI_API_KEY` | — | Google Gemini API key (also accepts `GOOGLE_API_KEY`) |
| `MISTRAL_API_KEY` | — | Mistral API key |
| `XAI_API_KEY` | — | xAI (Grok) API key |
| `OPENROUTER_API_KEY` | — | OpenRouter API key |
| `FALLBACK_API_KEY` | — | Fallback key (tried if provider-specific key is missing) |
| `OLLAMA_HOST` | `http://localhost:11434` | Ollama server URL |
| `OPENROUTER_BASE_URL` | `https://openrouter.ai/api/v1` | OpenRouter API URL |

API keys are resolved from environment variables or login shell (`bash -lc`) and cached on first use.

## Usage

```bash
# Direct
node server.js

# Custom config
MODELS="openai:gpt-4o,gemini:gemini-2.0-flash" PORT=9000 node server.js

# As a systemd service
cp model-chain-proxy.service /etc/systemd/system/
systemctl daemon-reload
systemctl enable --now model-chain-proxy
```

### Using with any OpenAI-compatible client

```bash
export OPENAI_BASE_URL=http://127.0.0.1:8367
```

## Monitoring

### `/health` and `/ready`

```bash
curl http://127.0.0.1:8367/health
# {"status":"ok","uptime":123.4,"models":3,"providers":["openai","anthropic"]}
```

### `/metrics`

Prometheus-style plain text metrics:

| Metric | Description |
|---|---|
| `proxy_requests_total` | Total client requests received |
| `proxy_errors_total` | Total 503 responses (entire chain failed) |
| `proxy_model_attempts_total{model="provider:model"}` | Times a model was tried |
| `proxy_model_failures_total{model="provider:model"}` | Times a model failed |
| `proxy_model_served_total{model="provider:model"}` | Requests a model fulfilled |
| `proxy_model_avg_ms{model="provider:model"}` | Average latency |

## Architecture

```
server.js              ← HTTP server + fallback orchestrator
lib/
  config.js            ← API key resolution, models.list parsing
  http.js              ← HTTP/HTTPS request primitive
providers/
  _openai-compat.js    ← Shared factory for OpenAI-compatible providers
  openai.js            ← OpenAI (5 lines — uses factory)
  mistral.js           ← Mistral (5 lines — uses factory)
  xai.js               ← xAI/Grok (5 lines — uses factory)
  openrouter.js        ← OpenRouter (5 lines — uses factory)
  ollama.js            ← Ollama (5 lines — uses factory)
  anthropic.js         ← Full request/response/stream translation
  gemini.js            ← Full request/response/stream translation
```

### Adding a new provider

For OpenAI-compatible providers, create a file in `providers/`:

```js
const { makeOpenAICompat } = require("./_openai-compat");
module.exports = makeOpenAICompat({
  baseUrl: "https://api.newprovider.com/v1",
  authHeader: (key) => ({ authorization: `Bearer ${key}` }),
});
```

Then add the provider name to `KEY_MAP` in `lib/config.js`.

## Requirements

- Node.js 18+
- Zero npm dependencies
