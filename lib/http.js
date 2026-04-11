const http = require("http");
const https = require("https");

const agents = {
  "https:": new https.Agent({ keepAlive: true }),
  "http:": new http.Agent({ keepAlive: true }),
};

function httpRequest(fullUrl, headers, bodyStr, { stream = false, timeout } = {}) {
  return new Promise((resolve, reject) => {
    const url = new URL(fullUrl);
    const mod = url.protocol === "https:" ? https : http;
    const to = timeout || (stream ? 90000 : 60000);

    const req = mod.request({
      hostname: url.hostname,
      port: url.port || (url.protocol === "https:" ? 443 : 80),
      path: url.pathname + url.search,
      method: "POST",
      headers: {
        ...headers,
        "content-length": Buffer.byteLength(bodyStr),
      },
      agent: agents[url.protocol],
      timeout: to,
    }, (res) => {
      if (stream && res.statusCode >= 400) {
        const chunks = [];
        res.on("data", (c) => chunks.push(c));
        res.on("end", () => {
          const msg = chunks.length ? Buffer.concat(chunks).toString().slice(0, 200) : `upstream ${res.statusCode}`;
          reject(new Error(`model error ${res.statusCode}: ${msg}`));
        });
        return;
      }
      if (stream) { resolve(res); return; }

      const chunks = [];
      res.on("data", (c) => chunks.push(c));
      res.on("end", () => resolve({
        status: res.statusCode,
        headers: res.headers,
        body: Buffer.concat(chunks),
      }));
    });

    req.on("timeout", () => { req.destroy(); reject(new Error("timeout")); });
    req.on("error", reject);
    req.end(bodyStr);
  });
}

// SSE stream adapter: buffers lines, parses "data: " events, calls onEvent(json).
// onEvent returns { text, done } or null to skip.
function adaptSseStream(upstreamRes, clientRes, onEvent) {
  return new Promise((resolve, reject) => {
  clientRes.writeHead(200, {
    "content-type": "text/event-stream",
    "cache-control": "no-cache",
    connection: "keep-alive",
  });

  let buffer = "";
  upstreamRes.on("data", (chunk) => {
    buffer += chunk.toString();
    const lines = buffer.split("\n");
    buffer = lines.pop();

    for (const line of lines) {
      if (!line.startsWith("data: ")) continue;
      const raw = line.slice(6).trim();
      if (!raw) continue;

      let event;
      try { event = JSON.parse(raw); } catch { continue; }

      const result = onEvent(event);
      if (!result) continue;

      if (result.done) {
        clientRes.write("data: [DONE]\n\n");
        continue;
      }

      if (result.text) {
        const openaiChunk = {
          id: result.id || `chatcmpl-${Date.now()}`,
          object: "chat.completion.chunk",
          choices: [{ index: 0, delta: { content: result.text }, finish_reason: null }],
        };
        clientRes.write(`data: ${JSON.stringify(openaiChunk)}\n\n`);
      }
    }
  });

  upstreamRes.on("end", () => { if (!clientRes.writableEnded) clientRes.end(); });
  upstreamRes.on("error", (err) => {
    if (!clientRes.writableEnded) {
      // Use data: format — event: error is ignored by most OpenAI-compat parsers.
      clientRes.write(`data: ${JSON.stringify({ error: { message: err.message, type: "server_error" } })}

`);
      clientRes.end();
    }
  });
}

module.exports = { httpRequest, adaptSseStream };
