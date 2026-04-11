const { adaptSseStream } = require("../lib/http");

module.exports = {
  buildRequest(body, model, apiKey) {
    const { messages, stream, max_tokens, temperature, top_p } = body;

    const systemMsg = messages.find((m) => m.role === "system");
    const filtered = messages.filter((m) => m.role !== "system");

    const endpoint = stream ? "streamGenerateContent" : "generateContent";
    const qs = stream ? `key=${apiKey}&alt=sse` : `key=${apiKey}`;

    const geminiBody = {
      contents: filtered.map((m) => ({
        role: m.role === "assistant" ? "model" : "user",
        parts: [{ text: typeof m.content === "string" ? m.content : JSON.stringify(m.content) }],
      })),
    };

    if (systemMsg) {
      geminiBody.systemInstruction = {
        parts: [{ text: systemMsg.content }],
      };
    }

    const genConfig = {};
    if (max_tokens) genConfig.maxOutputTokens = max_tokens;
    if (temperature !== undefined) genConfig.temperature = temperature;
    if (top_p !== undefined) genConfig.topP = top_p;
    if (Object.keys(genConfig).length > 0) geminiBody.generationConfig = genConfig;

    return {
      url: `https://generativelanguage.googleapis.com/v1beta/models/${model}:${endpoint}?${qs}`,
      headers: { "content-type": "application/json" },
      body: JSON.stringify(geminiBody),
    };
  },

  parseResponse(raw) {
    const body = JSON.parse(raw.toString());
    const candidate = body.candidates?.[0];
    const text = candidate?.content?.parts?.map((p) => p.text).join("") || "";
    const finishReason = candidate?.finishReason;

    return {
      id: `chatcmpl-gemini-${Date.now()}`,
      object: "chat.completion",
      model: body.modelVersion || "gemini",
      choices: [{
        index: 0,
        message: { role: "assistant", content: text },
        finish_reason: finishReason === "STOP" ? "stop"
          : finishReason === "MAX_TOKENS" ? "length"
          : finishReason?.toLowerCase() || "stop",
      }],
      usage: {
        prompt_tokens: body.usageMetadata?.promptTokenCount || 0,
        completion_tokens: body.usageMetadata?.candidatesTokenCount || 0,
        total_tokens: body.usageMetadata?.totalTokenCount || 0,
      },
    };
  },

  transformStream(upstreamRes, clientRes) {
    adaptSseStream(upstreamRes, clientRes, (event) => {
      const candidate = event.candidates?.[0];
      if (!candidate) return null;

      const text = candidate.content?.parts?.map((p) => p.text).filter(Boolean).join("");
      const isDone = candidate.finishReason && candidate.finishReason !== "FINISH_REASON_UNSPECIFIED";

      // Check text before isDone: the final Gemini event often carries both.
      // Returning {text, done} lets adaptSseStream emit the content chunk
      // before writing [DONE], so no text is ever lost.
      if (isDone) return { text: text || undefined, done: true };
      if (text) return { text };
      return null;
    });
  },
};
