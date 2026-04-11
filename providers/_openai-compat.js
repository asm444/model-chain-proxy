// Factory for OpenAI-compatible providers (OpenAI, Mistral, xAI, OpenRouter, Ollama).
// They all speak the same wire format — only URL, auth, and protocol differ.

function makeOpenAICompat({ baseUrl, authHeader }) {
  return {
    buildRequest(body, model, apiKey) {
      const url = `${baseUrl}/chat/completions`;
      const payload = JSON.stringify({ ...body, model });
      return {
        url,
        headers: {
          "content-type": "application/json",
          ...authHeader(apiKey),
        },
        body: payload,
      };
    },

    parseResponse(raw) {
      // already OpenAI format — pass through
      return JSON.parse(raw.toString());
    },

    transformStream(upstreamRes, clientRes) {
      // already OpenAI SSE — pipe directly, wrapped in a Promise so callers
      // can detect stream errors and update metrics correctly.
      return new Promise((resolve, reject) => {
        clientRes.writeHead(upstreamRes.statusCode, {
          "content-type": upstreamRes.headers["content-type"] || "text/event-stream",
          "cache-control": "no-cache",
          connection: "keep-alive",
        });
        upstreamRes.on("aborted", () => { if (!clientRes.writableEnded) clientRes.end(); reject(new Error("upstream aborted")); });
        upstreamRes.on("error", (err) => { if (!clientRes.writableEnded) clientRes.end(); reject(err); });
        upstreamRes.on("end", resolve);
        upstreamRes.pipe(clientRes);
      });
    },
  };
}

module.exports = { makeOpenAICompat };
