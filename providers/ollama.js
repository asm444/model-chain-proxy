const { makeOpenAICompat } = require("./_openai-compat");

module.exports = makeOpenAICompat({
  baseUrl: (process.env.OLLAMA_HOST || "http://localhost:11434") + "/v1",
  authHeader: () => ({}),
});
