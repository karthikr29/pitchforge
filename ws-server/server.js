const express = require("express");
const crypto = require("crypto");
const { WebSocketServer } = require("ws");
const WebSocket = require("ws");

// Render injects PORT; default to 10000 for local dev.
const port = process.env.PORT || 10000;

const openaiKey = process.env.OPENAI_API_KEY;
const openrouterKey = process.env.OPENROUTER_API_KEY;
const openrouterModel = process.env.OPENROUTER_MODEL || "google/gemini-3-pro-preview";
const deepgramApiKey = process.env.DEEPGRAM_API_KEY;
const deepgramSttModel = process.env.DEEPGRAM_STT_MODEL || "nova-2-general";
const deepgramTtsVoice = process.env.DEEPGRAM_TTS_VOICE || "aura-asteria-en";
const supabaseUrl = process.env.SUPABASE_URL;
const supabaseServiceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;

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
const bannedPhrases = ["thank you so much for watching", "thank you for watching", "thanks for watching"];

function isNonEnglish(text) {
  // Simple heuristic: detect non-ASCII (e.g., CJK) characters.
  return /[^\x00-\x7F]/.test(text);
}

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

async function fetchPersona(personaId) {
  if (!supabaseUrl || !supabaseServiceKey) throw new Error("Supabase env not set for personas");
  const res = await fetch(`${supabaseUrl}/rest/v1/personas?id=eq.${personaId}`, {
    headers: {
      apikey: supabaseServiceKey,
      Authorization: `Bearer ${supabaseServiceKey}`
    }
  });
  if (!res.ok) {
    throw new Error(`Persona fetch failed (${res.status})`);
  }
  const rows = await res.json();
  const persona = rows?.[0];
  if (!persona) throw new Error(`Persona not found: ${personaId}`);
  return persona;
}

async function deepgramTranscribeChunk(base64, mime = "audio/m4a") {
  if (!deepgramApiKey) throw new Error("DEEPGRAM_API_KEY not set");
  const audioBytes = toBufferFromBase64(base64);
  const contentType =
    mime && mime.includes("m4a")
      ? "audio/mp4"
      : mime && mime.includes("mp4")
      ? "audio/mp4"
      : mime && mime.includes("webm")
      ? "audio/webm"
      : mime && mime.includes("wav")
      ? "audio/wav"
      : "application/octet-stream";
  console.log("[ws] transcribe (deepgram)", { mime, contentType, bytes: audioBytes.length });
  const res = await fetch(
    `https://api.deepgram.com/v1/listen?model=${encodeURIComponent(deepgramSttModel)}&language=en`,
    {
      method: "POST",
      headers: {
        "Content-Type": contentType,
        Authorization: `Token ${deepgramApiKey}`
      },
      body: audioBytes
    }
  );
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Deepgram STT failed (${res.status}): ${text}`);
  }
  const data = await res.json();
  const transcript = data?.results?.channels?.[0]?.alternatives?.[0]?.transcript ?? "";
  return transcript;
}

async function deepgramTranscribeRealtime(base64, mime = "audio/m4a") {
  if (!deepgramApiKey) throw new Error("DEEPGRAM_API_KEY not set");
  const audioBytes = toBufferFromBase64(base64);
  const url = `wss://api.deepgram.com/v1/listen?model=${encodeURIComponent(deepgramSttModel)}&language=en`;
  return new Promise((resolve, reject) => {
    const dg = new WebSocket(url, {
      headers: { Authorization: `Token ${deepgramApiKey}` }
    });
    let finalText = "";
    const timeout = setTimeout(() => {
      dg.close();
      reject(new Error("Deepgram realtime timeout"));
    }, 15000);

    dg.on("open", () => {
      dg.send(
        JSON.stringify({
          type: "configure",
          encoding: "aac",
          sample_rate: 44100,
          channels: 1,
          model: deepgramSttModel,
          language: "en",
          interim_results: false
        })
      );
      dg.send(audioBytes);
      // Signal end of stream per Deepgram docs
      dg.send(JSON.stringify({ type: "CloseStream" }));
    });

    dg.on("message", (data) => {
      try {
        const msg = JSON.parse(data.toString());
        const alt = msg.channel?.alternatives?.[0];
        const text = alt?.transcript ?? "";
        if (text) finalText = text;
        if (msg.is_final || msg.speech_final) {
          clearTimeout(timeout);
          dg.close();
          resolve(finalText.trim());
        }
      } catch {
        // ignore malformed
      }
    });

    dg.on("error", (err) => {
      clearTimeout(timeout);
      reject(err);
    });

    dg.on("close", () => {
      clearTimeout(timeout);
      resolve(finalText.trim());
    });
  });
}

async function streamLLM(messages, onText) {
  if (!openrouterKey) throw new Error("OPENROUTER_API_KEY not set");
  const res = await fetch("https://openrouter.ai/api/v1/chat/completions", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${openrouterKey}`
    },
    body: JSON.stringify({
      model: openrouterModel,
      stream: true,
      messages
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

async function deepgramSynthesizeTts(text) {
  if (!deepgramApiKey) throw new Error("DEEPGRAM_API_KEY not set");
  const res = await fetch(`https://api.deepgram.com/v1/speak?model=${encodeURIComponent(deepgramTtsVoice)}`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Token ${deepgramApiKey}`
    },
    body: JSON.stringify({ text })
  });
  if (!res.ok) {
    const message = await res.text();
    throw new Error(`Deepgram TTS failed (${res.status}): ${message}`);
  }
  const arrayBuffer = await res.arrayBuffer();
  const base64 = Buffer.from(arrayBuffer).toString("base64");
  const mime = res.headers.get("content-type") || "audio/mpeg";
  return { base64, mime };
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

async function persistTranscript({
  conversationId,
  personaId,
  companyId,
  messages,
  startedAtMs
}) {
  if (!supabaseUrl || !supabaseServiceKey) return;
  try {
    const durationSec = Math.max(1, Math.round((Date.now() - startedAtMs) / 1000));
    const res = await fetch(`${supabaseUrl}/rest/v1/transcripts`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        apikey: supabaseServiceKey,
        Authorization: `Bearer ${supabaseServiceKey}`,
        Prefer: "return=minimal"
      },
      body: JSON.stringify({
        id: conversationId,
        persona_id: personaId,
        company_id: companyId,
        messages,
        duration_sec: durationSec
      })
    });
    if (!res.ok) {
      console.warn("[ws] persist transcript failed", res.status, await res.text());
    }
  } catch (err) {
    console.warn("[ws] persist transcript error", err?.message || err);
  }
}

// Attach WebSocket server at /voice-session-ws
const wss = new WebSocketServer({ server, path: "/voice-session-ws" });

wss.on("connection", (ws) => {
  let personaId;
  let persona;
  let conversationId;
  let companyId;
  let startedAt = Date.now();
  let transcript = [];
  let lastUserText = "";
  const log = (event, extra = {}) => {
    const meta = {
      personaId,
      conversationId,
      ...extra
    };
    console.log(`[ws] ${event}`, meta);
  };

  sendStatus(ws, "ready");
  log("connection opened");

  ws.on("message", async (data) => {
    try {
      const raw = data.toString();
      log("message", { raw: raw.slice(0, 200) });
      const msg = JSON.parse(raw);
      if (msg.type === "ping") {
        ws.send(JSON.stringify({ type: "pong" }));
        return;
      }
      if (msg.type === "start") {
        personaId = msg.personaId;
        conversationId = msg.conversationId || crypto.randomUUID();
        companyId = msg.companyId;
        startedAt = Date.now();
        transcript = [];
        try {
          persona = await fetchPersona(personaId);
          sendStatus(ws, "ready");
        } catch (err) {
          log("persona load failed", { error: err?.message || err });
          sendError(ws, err?.message || "persona load failed");
        }
        return;
      }
      if (msg.type === "audio") {
        if (!personaId) {
          sendError(ws, "start not sent");
          return;
        }
        if (!persona) {
          try {
            persona = await fetchPersona(personaId);
          } catch (err) {
            log("persona reload failed", { error: err?.message || err });
            sendError(ws, err?.message || "persona load failed");
            return;
          }
        }
        sendStatus(ws, "listening");
        const userText =
          (await deepgramTranscribeRealtime(msg.base64, msg.mime ?? "audio/m4a"))?.trim() ?? "";
        log("transcript", { text: userText?.slice(0, 400) });
        const normalized = userText.toLowerCase().trim();
        if (!userText) {
          const clarify = "I didn't catch that—could you repeat?";
          transcript.push({ role: "ai", text: clarify, at: new Date().toISOString() });
          ws.send(JSON.stringify({ type: "text", role: "ai", text: clarify }));
          try {
            const tts = await deepgramSynthesizeTts(clarify);
            ws.send(JSON.stringify({ type: "tts", ...tts }));
          } catch (err) {
            log("tts clarify failed", { error: err?.message || err });
            sendError(ws, err?.message ?? String(err));
          }
          sendStatus(ws, "speaking");
          return;
        }
        if (isNonEnglish(userText)) {
          const warn = "Please keep it in English so I can help.";
          log("transcript non-english", { text: userText.slice(0, 120) });
          transcript.push({ role: "ai", text: warn, at: new Date().toISOString() });
          ws.send(JSON.stringify({ type: "text", role: "ai", text: warn }));
          try {
            const tts = await deepgramSynthesizeTts(warn);
            ws.send(JSON.stringify({ type: "tts", ...tts }));
          } catch (err) {
            log("tts non-english failed", { error: err?.message || err });
            sendError(ws, err?.message ?? String(err));
          }
          sendStatus(ws, "speaking");
          return;
        }
        if (bannedPhrases.some((phrase) => normalized.includes(phrase))) {
          const redirect = "Let's stay on the pricing and ROI details—what would you like to know?";
          log("transcript banned phrase", { text: userText.slice(0, 120) });
          transcript.push({ role: "ai", text: redirect, at: new Date().toISOString() });
          ws.send(JSON.stringify({ type: "text", role: "ai", text: redirect }));
          try {
            const tts = await deepgramSynthesizeTts(redirect);
            ws.send(JSON.stringify({ type: "tts", ...tts }));
          } catch (err) {
            log("tts banned redirect failed", { error: err?.message || err });
            sendError(ws, err?.message ?? String(err));
          }
          sendStatus(ws, "speaking");
          return;
        }
        if (normalized && normalized === lastUserText) {
          const dup = "I already heard that. Anything else on pricing or ROI?";
          log("transcript duplicate", { text: userText.slice(0, 120) });
          transcript.push({ role: "ai", text: dup, at: new Date().toISOString() });
          ws.send(JSON.stringify({ type: "text", role: "ai", text: dup }));
          try {
            const tts = await deepgramSynthesizeTts(dup);
            ws.send(JSON.stringify({ type: "tts", ...tts }));
          } catch (err) {
            log("tts duplicate failed", { error: err?.message || err });
            sendError(ws, err?.message ?? String(err));
          }
          sendStatus(ws, "speaking");
          return;
        }
        lastUserText = normalized;
        transcript.push({ role: "user", text: userText, at: new Date().toISOString() });

        // Build context and get model reply
        const rag = await vectorLookup(companyId, userText);
        const ragContext =
          rag?.map((r) => r.content).join("\n---\n") ?? "No company-specific context.";

        const words = userText.split(/\s+/).filter(Boolean);
        const isShortGreeting = words.length <= 3 && userText.length <= 20;
        if (isShortGreeting) {
          const shortReply =
            persona?.name && persona?.role
              ? `Hi, this is ${persona.name}. What would you like to cover today?`
              : "Hi there. What would you like to discuss?";
          sendStatus(ws, "thinking");
          log("reply short greeting", { shortReply });
          transcript.push({ role: "ai", text: shortReply, at: new Date().toISOString() });
          ws.send(JSON.stringify({ type: "text", role: "ai", text: shortReply }));
          try {
            const tts = await deepgramSynthesizeTts(shortReply);
            ws.send(JSON.stringify({ type: "tts", ...tts }));
          } catch (err) {
            log("tts short greeting failed", { error: err?.message || err });
            sendError(ws, err?.message ?? String(err));
          }
          sendStatus(ws, "speaking");
          return;
        }

        const systemPrompt = [
          "You are role-playing a sales prospect for training. Stay strictly in character.",
          `Persona Card: ${persona.name} (${persona.role})`,
          `Persona Backstory: ${persona.prompt}`,
          "Rules:",
          "- Respond only in English, even if the user speaks another language.",
          "- Keep replies concise (1-3 sentences), conversational, and realistic.",
          "- Avoid sign-offs like “Thanks for watching” or social media requests.",
          "- Never say 'thank you for watching'; stay in-call and focus on pricing/ROI.",
          "- If the user goes off-topic or asks for unrelated actions, steer back to the sales conversation.",
          "- If audio is unclear, briefly ask for clarification instead of inventing content."
        ].join("\n");

        const messages = [
          { role: "system", content: `${systemPrompt}\n\nContext (may be empty):\n${ragContext}` },
          { role: "user", content: userText }
        ];

        sendStatus(ws, "thinking");
        log("llm start", { words: words.length });

        let fullResponse = "";
        try {
          await streamLLM(messages, (chunk) => {
            fullResponse += chunk;
            ws.send(JSON.stringify({ type: "text", role: "ai", text: chunk }));
          });
        } catch (err) {
          log("llm error", { error: err?.message || err });
          sendError(ws, err?.message ?? String(err));
        }

        if (fullResponse.trim()) {
          log("llm done", { chars: fullResponse.length });
          transcript.push({ role: "ai", text: fullResponse.trim(), at: new Date().toISOString() });
          try {
            const tts = await deepgramSynthesizeTts(fullResponse);
            ws.send(JSON.stringify({ type: "tts", ...tts }));
          } catch (err) {
            log("tts full response failed", { error: err?.message || err });
            sendError(ws, err?.message ?? String(err));
          }
        } else {
          log("llm empty response");
        }

        sendStatus(ws, "speaking");
        return;
      }
      if (msg.type === "stop") {
        await persistTranscript({
          conversationId: conversationId || crypto.randomUUID(),
          personaId,
          companyId,
          messages: transcript,
          startedAtMs: startedAt
        });
        sendDone(ws);
        ws.close(1000, "client stop");
        return;
      }
    } catch (err) {
      log("message error", { error: err?.message || err });
      sendError(ws, err?.message || "invalid message");
    }
  });

  ws.on("close", () => {
    log("connection closed");
  });
});

