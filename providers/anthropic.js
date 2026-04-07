const { adaptSseStream } = require("../lib/http");
const ANTHROPIC_VERSION = "2023-06-01";

module.exports = {
  buildRequest(body, model, apiKey) {
    const { messages, stream, max_tokens, temperature, top_p } = body;

    // Anthropic treats system as a top-level field, not a message
    const systemMsg = messages.find((m) => m.role === "system");
    const filtered = messages.filter((m) => m.role !== "system");

    const anthropicBody = {
      model,
      messages: filtered,
      max_tokens: max_tokens || 4096,
      stream: stream || false,
    };
    if (systemMsg) anthropicBody.system = systemMsg.content;
    if (temperature !== undefined) anthropicBody.temperature = temperature;
    if (top_p !== undefined) anthropicBody.top_p = top_p;

    return {
      url: "https://api.anthropic.com/v1/messages",
      headers: {
        "content-type": "application/json",
        "x-api-key": apiKey,
        "anthropic-version": ANTHROPIC_VERSION,
      },
      body: JSON.stringify(anthropicBody),
    };
  },

  parseResponse(raw) {
    const body = JSON.parse(raw.toString());
    const text = body.content
      .filter((b) => b.type === "text")
      .map((b) => b.text)
      .join("");

    return {
      id: body.id,
      object: "chat.completion",
      model: body.model,
      choices: [{
        index: 0,
        message: { role: "assistant", content: text },
        finish_reason: body.stop_reason === "end_turn" ? "stop"
          : body.stop_reason === "max_tokens" ? "length"
          : body.stop_reason || "stop",
      }],
      usage: {
        prompt_tokens: body.usage?.input_tokens || 0,
        completion_tokens: body.usage?.output_tokens || 0,
        total_tokens: (body.usage?.input_tokens || 0) + (body.usage?.output_tokens || 0),
      },
    };
  },

  transformStream(upstreamRes, clientRes) {
    let messageId = "chatcmpl-anthropic";
    adaptSseStream(upstreamRes, clientRes, (event) => {
      if (event.type === "message_start" && event.message?.id) {
        messageId = event.message.id;
        return null;
      }
      if (event.type === "content_block_delta" && event.delta?.text) {
        return { text: event.delta.text, id: messageId };
      }
      if (event.type === "message_stop") {
        return { done: true };
      }
      return null;
    });
  },
};
