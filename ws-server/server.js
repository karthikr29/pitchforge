const express = require("express");
const { WebSocketServer } = require("ws");

// Render injects PORT; default to 10000 for local dev.
const port = process.env.PORT || 10000;

const openaiKey = process.env.OPENAI_API_KEY;
const openrouterKey = process.env.OPENROUTER_API_KEY;
const supabaseUrl = process.env.SUPABASE_URL;
const supabaseServiceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
const echoOnly = (process.env.ECHO_ONLY || "true").toLowerCase() === "true";

const app = express();

// Basic health endpoint (optional, useful for Render health checks)
app.get("/health", (_req, res) => {
  res.status(200).send("ok");
});

const server = app.listen(port, () => {
  console.log(`WS server listening on ${port}`);
});

// Helpers
const encoder = new TextEncoder();

function toBufferFromBase64(input) {
  const cleaned = input.includes(",") ? input.split(",").pop() ?? input : input;
  return Buffer.from(cleaned, "base64");
}

async function embed(text) {
  if (!openaiKey) throw new Error("OPENAI_API_KEY not set");
  const res = await fetch("https://api.openai.com/v1/embeddings", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${openaiKey}`
    },
    body: JSON.stringify({ model: "text-embedding-3-small", input: text })
  });
  if (!res.ok) throw new Error(`Embedding failed (${res.status})`);
  const json = await res.json();
  return json.data?.[0]?.embedding ?? [];
}

async function vectorLookup(companyId, query) {
  if (!companyId) return [];
  if (!supabaseUrl || !supabaseServiceKey) return [];
  const embedding = await embed(query);
  const res = await fetch(`${supabaseUrl}/rest/v1/rpc/match_documents`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      apikey: supabaseServiceKey,
      Authorization: `Bearer ${supabaseServiceKey}`
    },
    body: JSON.stringify({
      query_embedding: embedding,
      company_id: companyId,
      match_count: 4
    })
  });
  if (!res.ok) {
    console.warn("vector lookup error", res.status, await res.text());
    return [];
  }
  const data = await res.json();
  return data ?? [];
}

async function transcribeChunk(base64, mime = "audio/webm") {
  if (!openaiKey) throw new Error("OPENAI_API_KEY not set");
  const audioBytes = toBufferFromBase64(base64);
  const ext =
    mime.includes("m4a") ? "m4a" : mime.includes("wav") ? "wav" : mime.includes("ogg") ? "ogg" : "webm";
  const formData = new FormData();
  formData.append("file", new Blob([audioBytes], { type: mime }), `audio.${ext}`);
  formData.append("model", "whisper-1");
  console.log("[ws] transcribe", { mime, bytes: audioBytes.length, ext });
  const res = await fetch("https://api.openai.com/v1/audio/transcriptions", {
    method: "POST",
    headers: { Authorization: `Bearer ${openaiKey}` },
    body: formData
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Whisper failed (${res.status}): ${text}`);
  }
  const data = await res.json();
  return data.text;
}

async function streamLLM(prompt, onText) {
  if (!openrouterKey) throw new Error("OPENROUTER_API_KEY not set");
  const res = await fetch("https://openrouter.ai/api/v1/chat/completions", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${openrouterKey}`
    },
    body: JSON.stringify({
      model: "google/gemini-3-pro-preview",
      stream: true,
      messages: [{ role: "user", content: prompt }]
    })
  });
  if (!res.ok || !res.body) throw new Error(`Gemini error ${res.status}`);

  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  while (true) {
    const { value, done } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value);
    const lines = buffer.split("\n");
    buffer = lines.pop() ?? "";
    for (const line of lines) {
      if (!line.startsWith("data:")) continue;
      const payload = line.replace("data:", "").trim();
      if (payload === "[DONE]") return;
      try {
        const parsed = JSON.parse(payload);
        const text = parsed.choices?.[0]?.delta?.content ?? "";
        if (text) onText(text);
      } catch {
        // ignore malformed chunks
      }
    }
  }
}

async function synthesizeTts(text) {
  if (!openaiKey) throw new Error("OPENAI_API_KEY not set");
  const res = await fetch("https://api.openai.com/v1/audio/speech", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${openaiKey}`
    },
    body: JSON.stringify({
      model: "tts-1",
      voice: "alloy",
      input: text
    })
  });
  if (!res.ok) {
    const message = await res.text();
    throw new Error(`TTS failed: ${message}`);
  }
  const arrayBuffer = await res.arrayBuffer();
  const base64 = Buffer.from(arrayBuffer).toString("base64");
  return { base64, mime: "audio/mpeg" };
}

function sendStatus(ws, value) {
  ws.send(JSON.stringify({ type: "status", value }));
}

function sendError(ws, message) {
  ws.send(JSON.stringify({ type: "error", message }));
}

function sendDone(ws) {
  ws.send(JSON.stringify({ type: "done" }));
}

// Attach WebSocket server at /voice-session-ws
const wss = new WebSocketServer({ server, path: "/voice-session-ws" });

wss.on("connection", (ws) => {
  let personaId;
  let conversationId;
  let companyId;

  sendStatus(ws, "ready");
  console.log("[ws] connection opened");

  ws.on("message", async (data) => {
    try {
      const raw = data.toString();
      console.log("[ws] message", raw.slice(0, 120));
      const msg = JSON.parse(raw);
      if (msg.type === "ping") {
        ws.send(JSON.stringify({ type: "pong" }));
        return;
      }
      if (msg.type === "start") {
        personaId = msg.personaId;
        conversationId = msg.conversationId;
        companyId = msg.companyId;
        sendStatus(ws, "ready");
        return;
      }
      if (msg.type === "audio") {
        if (!personaId) {
          sendError(ws, "start not sent");
          return;
        }
        sendStatus(ws, "listening");
        const userText = await transcribeChunk(msg.base64, msg.mime ?? "audio/webm");
        console.log("[ws] transcript", userText);

        // Always send transcript back as text so client can display it.
        ws.send(JSON.stringify({ type: "text", role: "ai", text: userText }));

        if (!echoOnly) {
          const rag = await vectorLookup(companyId, userText);
          const ragContext =
            rag?.map((r) => r.content).join("\n---\n") ?? "No company-specific context.";

          const prompt = [
            `Persona: ${personaId}`,
            "Use the following context if relevant:",
            ragContext,
            `User said: ${userText}`
          ].join("\n\n");

          sendStatus(ws, "thinking");

          let fullResponse = "";
          try {
            await streamLLM(prompt, (chunk) => {
              fullResponse += chunk;
              ws.send(JSON.stringify({ type: "text", role: "ai", text: chunk }));
            });
          } catch (err) {
            sendError(ws, err?.message ?? String(err));
          }

          if (fullResponse.trim()) {
            try {
              const tts = await synthesizeTts(fullResponse);
              ws.send(JSON.stringify({ type: "tts", ...tts }));
            } catch (err) {
              sendError(ws, err?.message ?? String(err));
            }
          }
        } else {
          // Echo-only: send TTS of the transcript itself so user hears it back.
          try {
            const tts = await synthesizeTts(userText);
            ws.send(JSON.stringify({ type: "tts", ...tts }));
          } catch (err) {
            sendError(ws, err?.message ?? String(err));
          }
        }

        sendStatus(ws, "speaking");
        return;
      }
      if (msg.type === "stop") {
        sendDone(ws);
        ws.close(1000, "client stop");
        return;
      }
    } catch (err) {
      sendError(ws, err?.message || "invalid message");
    }
  });

  ws.on("close", () => {
    console.log("[ws] connection closed");
  });
});

