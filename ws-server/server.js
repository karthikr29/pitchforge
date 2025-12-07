const express = require("express");
const { WebSocketServer } = require("ws");

// Render injects PORT; default to 10000 for local dev.
const port = process.env.PORT || 10000;

const app = express();

// Basic health endpoint (optional, useful for Render health checks)
app.get("/health", (_req, res) => {
  res.status(200).send("ok");
});

const server = app.listen(port, () => {
  console.log(`WS server listening on ${port}`);
});

// Attach WebSocket server at /voice-session-ws
const wss = new WebSocketServer({ server, path: "/voice-session-ws" });

wss.on("connection", (ws) => {
  // Send initial ready status
  ws.send(JSON.stringify({ type: "status", value: "ready" }));

  ws.on("message", (data) => {
    try {
      const msg = JSON.parse(data.toString());
      if (msg.type === "ping") {
        ws.send(JSON.stringify({ type: "pong" }));
      }
      // TODO: implement start/audio/stop handling, ASR, RAG, TTS, etc.
    } catch (err) {
      ws.send(JSON.stringify({ type: "error", message: err?.message || "invalid message" }));
    }
  });

  ws.on("close", () => {
    // cleanup if needed
  });
});

