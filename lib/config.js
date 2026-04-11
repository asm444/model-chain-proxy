const fs = require("fs");
const path = require("path");
const KEY_MAP = {
  openai:     ["OPENAI_API_KEY"],
  anthropic:  ["ANTHROPIC_API_KEY"],
  gemini:     ["GEMINI_API_KEY", "GOOGLE_API_KEY"],
  openrouter: ["OPENROUTER_API_KEY", "OPENAI_API_KEY"],
  mistral:    ["MISTRAL_API_KEY"],
  xai:        ["XAI_API_KEY"],
  ollama:     [],
};

const FALLBACK_KEYS = ["FALLBACK_API_KEY"];

const _resolved = new Map();

function resolveApiKey(provider) {
  if (_resolved.has(provider)) return _resolved.get(provider);

  const candidates = [...(KEY_MAP[provider] || []), ...FALLBACK_KEYS];
  for (const envVar of candidates) {
    const val = process.env[envVar] || "";
    if (val) { _resolved.set(provider, val); return val; }
  }

  _resolved.set(provider, null);
  return null;
}

function loadModels(file) {
  const raw = fs.readFileSync(file, "utf8").trim();
  const entries = raw
    .split("\n")
    .map((l) => l.trim())
    .filter((l) => l && !l.startsWith("#"));

  if (entries.length === 0) throw new Error("No models configured in models.list");
  return entries.map(parseModelEntry);
}

function parseModelEntry(entry) {
  const colon = entry.indexOf(":");
  if (colon === -1) {
    // backward compat: no prefix → assume openrouter
    return { provider: "openrouter", model: entry };
  }
  const prefix = entry.slice(0, colon);
  const rest = entry.slice(colon + 1);
  // handle entries like "openrouter:qwen/qwen3:free" where model itself has colons
  if (KEY_MAP.hasOwnProperty(prefix)) {
    return { provider: prefix, model: rest };
  }
  // not a known provider prefix — treat entire string as openrouter model
  return { provider: "openrouter", model: entry };
}

function loadModelList() {
  if (process.env.MODELS) {
    return process.env.MODELS
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean)
      .map(parseModelEntry);
  }
  return loadModels(path.join(__dirname, "..", "models.list"));
}

module.exports = { resolveApiKey, loadModelList, KEY_MAP };
