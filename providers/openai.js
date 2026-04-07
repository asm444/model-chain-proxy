const { makeOpenAICompat } = require("./_openai-compat");

module.exports = makeOpenAICompat({
  baseUrl: "https://api.openai.com/v1",
  authHeader: (key) => ({ authorization: `Bearer ${key}` }),
});
