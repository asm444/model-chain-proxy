const http = require("http");
const https = require("https");

const MAX_BODY_BYTES = 10 * 1024 * 1024; // 10 MB

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

// Buffers the full body from a readable stream, rejecting if it exceeds maxBytes.
// Uses stream.resume() instead of stream.destroy() so the socket stays open
// long enough to send the 413 response back to the client.
function bufferBody(stream, maxBytes = MAX_BODY_BYTES) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let totalBytes = 0;
    let settled = false;

    stream.on("data", (chunk) => {
      if (settled) return;
      totalBytes += chunk.length;
      if (totalBytes > maxBytes) {
        settled = true;
        stream.resume(); // drain remaining data without storing; keeps socket open
        const err = new Error("Payload too large");
        err.statusCode = 413;
        reject(err);
        return;
      }
      chunks.push(chunk);
    });

    stream.on("error", (err) => { if (!settled) { settled = true; reject(err); } });
    stream.on("end",   ()    => { if (!settled) { settled = true; resolve(Buffer.concat(chunks)); } });
  });
}

// Picks forwarding headers from the client request.
function pickClientHeaders(clientHeaders) {
  const h = {};
  for (const k of ["user-agent", "http-referer"]) {
    if (clientHeaders[k]) h[k] = clientHeaders[k];
  }
  return h;
}

// SSE stream adapter: buffers lines, parses "data: " events, calls onEvent(json).
// onEvent returns { text, done } or null to skip. Returns a Promise that resolves
// when the stream ends cleanly, or rejects on upstream error.
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

        // Emit text before done so the last chunk's text is never lost.
        if (result.text) {
          const openaiChunk = {
            id: result.id || `chatcmpl-${Date.now()}`,
            object: "chat.completion.chunk",
            choices: [{ index: 0, delta: { content: result.text }, finish_reason: null }],
          };
          clientRes.write(`data: ${JSON.stringify(openaiChunk)}\n\n`);
        }

        if (result.done) {
          clientRes.write("data: [DONE]\n\n");
        }
      }
    });

    upstreamRes.on("end", () => {
      if (!clientRes.writableEnded) clientRes.end();
      resolve();
    });

    upstreamRes.on("error", (err) => {
      if (!clientRes.writableEnded) {
        // Use data: format (not event: error) for OpenAI-compat client compatibility.
        clientRes.write(`data: ${JSON.stringify({ error: { message: err.message, type: "server_error" } })}\n\n`);
        clientRes.end();
      }
      reject(err);
    });
  });
}

module.exports = { httpRequest, bufferBody, pickClientHeaders, adaptSseStream };
