const { makeOpenAICompat } = require("./_openai-compat");

module.exports = makeOpenAICompat({
  baseUrl: process.env.OPENROUTER_BASE_URL || "https://openrouter.ai/api/v1",
  authHeader: (key) => ({ authorization: `Bearer ${key}` }),
});
