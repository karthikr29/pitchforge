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

// Legacy: Transcribe a complete audio file chunk via REST API
async function deepgramTranscribeChunk(base64, mime = "audio/m4a", meta = {}) {
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
  console.log("[ws] transcribe (deepgram REST)", {
    mime,
    contentType,
    bytes: audioBytes.length,
    model: deepgramSttModel,
    ...meta
  });
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
  const requestId = res.headers.get("dg-request-id") || res.headers.get("x-request-id");
  console.log("[ws] transcribe (deepgram REST) complete", {
    transcriptPreview: transcript.slice(0, 120),
    transcriptLen: transcript.length,
    requestId,
    model: deepgramSttModel,
    ...meta
  });
  return transcript;
}

// Create a persistent Deepgram streaming connection for real-time STT
function createDeepgramStreamConnection(config, meta = {}) {
  if (!deepgramApiKey) throw new Error("DEEPGRAM_API_KEY not set");
  
  const { sampleRate = 16000, channels = 1, encoding = "linear16" } = config;
  
  // Map client encoding to Deepgram encoding
  let dgEncoding = "linear16";
  if (encoding === "pcm_16bit" || encoding === "linear16") {
    dgEncoding = "linear16";
  } else if (encoding === "opus") {
    dgEncoding = "opus";
  }
  
  const params = new URLSearchParams({
    model: deepgramSttModel,
    language: "en",
    encoding: dgEncoding,
    sample_rate: String(sampleRate),
    channels: String(channels),
    punctuate: "true",
    interim_results: "true",
    utterance_end_ms: "1000",
    vad_events: "true",
    endpointing: "300"  // 300ms endpointing for turn detection
  });
  
  const url = `wss://api.deepgram.com/v1/listen?${params.toString()}`;
  console.log("[ws] deepgram stream connect", {
    url: url.replace(deepgramApiKey, "***"),
    params: Object.fromEntries(params.entries()),
    ...meta
  });
  
  const dgWs = new WebSocket(url, {
    headers: { Authorization: `Token ${deepgramApiKey}` }
  });
  
  return dgWs;
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

async function deepgramSynthesizeTts(text, meta = {}) {
  if (!deepgramApiKey) throw new Error("DEEPGRAM_API_KEY not set");
  console.log("[ws] tts request (deepgram)", {
    model: deepgramTtsVoice,
    textLen: text?.length ?? 0,
    textPreview: (text || "").slice(0, 120),
    ...meta
  });
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
    console.warn("[ws] tts failed (deepgram)", {
      status: res.status,
      message,
      model: deepgramTtsVoice,
      ...meta
    });
    throw new Error(`Deepgram TTS failed (${res.status}): ${message}`);
  }
  const arrayBuffer = await res.arrayBuffer();
  const base64 = Buffer.from(arrayBuffer).toString("base64");
  const mime = res.headers.get("content-type") || "audio/mpeg";
  const requestId = res.headers.get("dg-request-id") || res.headers.get("x-request-id");
  console.log("[ws] tts response (deepgram)", {
    model: deepgramTtsVoice,
    mime,
    audioBytes: arrayBuffer.byteLength,
    base64Len: base64.length,
    requestId,
    ...meta
  });
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

function sendTranscript(ws, text) {
  ws.send(JSON.stringify({ type: "transcript", text }));
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
  
  // Streaming audio state
  let deepgramWs = null;
  let streamConfig = null;
  let streamingTranscript = "";
  let processingResponse = false;
  
  const log = (event, extra = {}) => {
    const meta = {
      personaId,
      conversationId,
      ...extra
    };
    console.log(`[ws] ${event}`, meta);
  };

  // Process the user's transcribed text and generate AI response
  async function processUserTurn(userText) {
    if (processingResponse) {
      log("skipping duplicate process call");
      return;
    }
    processingResponse = true;
    
    try {
      const normalized = userText.toLowerCase().trim();
      log("processing turn", { text: userText.slice(0, 200) });
      
      // Send transcript to client
      sendTranscript(ws, userText);
      
      if (!userText) {
        const clarify = "I didn't catch that—could you repeat?";
        transcript.push({ role: "ai", text: clarify, at: new Date().toISOString() });
        ws.send(JSON.stringify({ type: "text", role: "ai", text: clarify }));
        try {
          const tts = await deepgramSynthesizeTts(clarify, { personaId, conversationId, stage: "clarify-empty" });
          ws.send(JSON.stringify({ type: "tts", voiceModel: deepgramTtsVoice, ...tts }));
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
          const tts = await deepgramSynthesizeTts(warn, { personaId, conversationId, stage: "non-english" });
          ws.send(JSON.stringify({ type: "tts", voiceModel: deepgramTtsVoice, ...tts }));
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
          const tts = await deepgramSynthesizeTts(redirect, { personaId, conversationId, stage: "banned-redirect" });
          ws.send(JSON.stringify({ type: "tts", voiceModel: deepgramTtsVoice, ...tts }));
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
          const tts = await deepgramSynthesizeTts(dup, { personaId, conversationId, stage: "duplicate" });
          ws.send(JSON.stringify({ type: "tts", voiceModel: deepgramTtsVoice, ...tts }));
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
      const ragContext = rag?.map((r) => r.content).join("\n---\n") ?? "No company-specific context.";

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
          const tts = await deepgramSynthesizeTts(shortReply, { personaId, conversationId, stage: "short-greeting" });
          ws.send(JSON.stringify({ type: "tts", voiceModel: deepgramTtsVoice, ...tts }));
        } catch (err) {
          log("tts short greeting failed", { error: err?.message || err });
          sendError(ws, err?.message ?? String(err));
        }
        sendStatus(ws, "speaking");
        return;
      }

      const systemPrompt = [
        "You are role-playing a sales prospect for training. Stay strictly in character.",
        `Persona Card: ${persona?.name || "Unknown"} (${persona?.role || "Prospect"})`,
        `Persona Backstory: ${persona?.prompt || "A typical sales prospect."}`,
        "Rules:",
        "- Respond only in English, even if the user speaks another language.",
        "- Keep replies concise (1-3 sentences), conversational, and realistic.",
        "- Avoid sign-offs like 'Thanks for watching' or social media requests.",
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
          const tts = await deepgramSynthesizeTts(fullResponse, { personaId, conversationId, stage: "llm-full-response" });
          ws.send(JSON.stringify({ type: "tts", voiceModel: deepgramTtsVoice, ...tts }));
        } catch (err) {
          log("tts full response failed", { error: err?.message || err });
          sendError(ws, err?.message ?? String(err));
        }
      } else {
        log("llm empty response");
      }

      sendStatus(ws, "speaking");
    } finally {
      processingResponse = false;
    }
  }

  // Set up Deepgram streaming handlers
  function setupDeepgramStream() {
    if (!deepgramWs) return;
    
    deepgramWs.on("open", () => {
      log("deepgram stream opened");
      sendStatus(ws, "listening");
    });
    
    deepgramWs.on("message", (data) => {
      try {
        const msg = JSON.parse(data.toString());
        
        // Handle transcript messages
        if (msg.type === "Results") {
          const alt = msg.channel?.alternatives?.[0];
          const text = alt?.transcript ?? "";
          const isFinal = msg.is_final === true;
          const speechFinal = msg.speech_final === true;
          
          if (text) {
            if (isFinal) {
              // Accumulate final transcript pieces
              streamingTranscript += (streamingTranscript ? " " : "") + text;
              log("deepgram interim final", { text: text.slice(0, 100), accumulated: streamingTranscript.length });
            }
            
            // On speech_final, process the complete utterance
            if (speechFinal && streamingTranscript.trim()) {
              log("deepgram speech_final", { transcript: streamingTranscript.slice(0, 200) });
              const finalText = streamingTranscript.trim();
              streamingTranscript = "";
              processUserTurn(finalText);
            }
          }
        }
        
        // Handle utterance end (silence detection)
        if (msg.type === "UtteranceEnd") {
          log("deepgram utterance_end", { transcript: streamingTranscript.slice(0, 200) });
          if (streamingTranscript.trim()) {
            const finalText = streamingTranscript.trim();
            streamingTranscript = "";
            processUserTurn(finalText);
          }
        }
        
        // Handle speech started event
        if (msg.type === "SpeechStarted") {
          log("deepgram speech_started");
        }
        
      } catch (err) {
        log("deepgram message parse error", { error: err?.message || err });
      }
    });
    
    deepgramWs.on("error", (err) => {
      log("deepgram stream error", { error: err?.message || err });
    });
    
    deepgramWs.on("close", (code, reason) => {
      log("deepgram stream closed", { code, reason: reason?.toString() });
      deepgramWs = null;
      
      // Process any remaining transcript
      if (streamingTranscript.trim()) {
        const finalText = streamingTranscript.trim();
        streamingTranscript = "";
        processUserTurn(finalText);
      }
    });
  }

  // Close Deepgram stream gracefully
  function closeDeepgramStream() {
    if (deepgramWs && deepgramWs.readyState === WebSocket.OPEN) {
      try {
        // Send CloseStream message per Deepgram docs
        deepgramWs.send(JSON.stringify({ type: "CloseStream" }));
      } catch (err) {
        log("deepgram close error", { error: err?.message || err });
      }
    }
    deepgramWs = null;
    streamConfig = null;
  }

  sendStatus(ws, "ready");
  log("connection opened");

  ws.on("message", async (data) => {
    try {
      const raw = data.toString();
      // Don't log full audio chunks (too large)
      const logRaw = raw.length > 500 ? raw.slice(0, 200) + "...[truncated]" : raw;
      log("message", { raw: logRaw });
      
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
        streamingTranscript = "";
        try {
          persona = await fetchPersona(personaId);
          sendStatus(ws, "ready");
        } catch (err) {
          log("persona load failed", { error: err?.message || err });
          sendError(ws, err?.message || "persona load failed");
        }
        return;
      }
      
      // Handle streaming audio start
      if (msg.type === "audio-stream-start") {
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
        
        // Close any existing stream
        closeDeepgramStream();
        
        // Store stream config
        streamConfig = {
          sampleRate: msg.sampleRate || 16000,
          channels: msg.channels || 1,
          encoding: msg.encoding || "pcm_16bit"
        };
        
        // Create new Deepgram stream
        streamingTranscript = "";
        deepgramWs = createDeepgramStreamConnection(streamConfig, { personaId, conversationId });
        setupDeepgramStream();
        
        log("audio stream started", streamConfig);
        return;
      }
      
      // Handle streaming audio chunk
      if (msg.type === "audio-chunk") {
        if (!deepgramWs || deepgramWs.readyState !== WebSocket.OPEN) {
          // If no stream is open, silently ignore (might be late chunks after stream ended)
          log("audio chunk ignored (no stream)", { base64Len: msg.base64?.length || 0 });
          return;
        }
        
        const audioBytes = toBufferFromBase64(msg.base64 || "");
        if (audioBytes.length > 0) {
          deepgramWs.send(audioBytes);
        }
        return;
      }
      
      // Handle streaming audio end
      if (msg.type === "audio-stream-end") {
        log("audio stream end requested", { hasTranscript: streamingTranscript.length > 0 });
        
        if (deepgramWs && deepgramWs.readyState === WebSocket.OPEN) {
          // Send CloseStream to get final results
          try {
            deepgramWs.send(JSON.stringify({ type: "CloseStream" }));
          } catch (err) {
            log("deepgram close stream error", { error: err?.message || err });
          }
        }
        
        // Process any accumulated transcript if Deepgram hasn't sent speech_final
        setTimeout(() => {
          if (streamingTranscript.trim() && !processingResponse) {
            const finalText = streamingTranscript.trim();
            streamingTranscript = "";
            log("processing remaining transcript on stream end", { text: finalText.slice(0, 200) });
            processUserTurn(finalText);
          }
          closeDeepgramStream();
        }, 500);
        
        return;
      }
      
      // Legacy: Handle complete audio file (for backwards compatibility)
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
        const base64Len = msg.base64?.length || 0;
        const mime = msg.mime ?? "audio/m4a";
        const bytesLen = toBufferFromBase64(msg.base64 || "").length;
        log("audio received (legacy)", { mime, base64Len, bytesLen });
        
        if (!bytesLen) {
          const clarify = "I didn't catch that—could you repeat?";
          transcript.push({ role: "ai", text: clarify, at: new Date().toISOString() });
          ws.send(JSON.stringify({ type: "text", role: "ai", text: clarify }));
          try {
            const tts = await deepgramSynthesizeTts(clarify, { personaId, conversationId, stage: "clarify-empty-audio" });
            ws.send(JSON.stringify({ type: "tts", voiceModel: deepgramTtsVoice, ...tts }));
          } catch (err) {
            log("tts clarify failed", { error: err?.message || err });
            sendError(ws, err?.message ?? String(err));
          }
          sendStatus(ws, "speaking");
          return;
        }
        
        sendStatus(ws, "listening");
        
        // Use REST API for file-based audio
        const userText = (await deepgramTranscribeChunk(msg.base64, mime, { personaId, conversationId }))?.trim() ?? "";
        await processUserTurn(userText);
        return;
      }
      
      if (msg.type === "stop") {
        closeDeepgramStream();
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
    closeDeepgramStream();
    log("connection closed");
  });
});
