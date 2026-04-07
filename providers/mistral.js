const { makeOpenAICompat } = require("./_openai-compat");

module.exports = makeOpenAICompat({
  baseUrl: "https://api.mistral.ai/v1",
  authHeader: (key) => ({ authorization: `Bearer ${key}` }),
});
