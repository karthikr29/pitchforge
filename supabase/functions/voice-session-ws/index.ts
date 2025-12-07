// deno-lint-ignore-file no-explicit-any
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.46.0";

const supabaseUrl = Deno.env.get("SUPABASE_URL")!;
const supabaseKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const openaiKey = Deno.env.get("OPENAI_API_KEY")!;
const openrouterKey = Deno.env.get("OPENROUTER_API_KEY")!;

const supabase = createClient(supabaseUrl, supabaseKey);
const encoder = new TextEncoder();

type WSMessage =
  | { type: "start"; personaId: string; conversationId?: string; companyId?: string }
  | { type: "audio"; id: string; mime: string; base64: string }
  | { type: "stop" }
  | { type: "ping" };

const STATUS = (value: string) => encoder.encode(JSON.stringify({ type: "status", value }) + "\n");
const ERROR = (message: string) =>
  encoder.encode(JSON.stringify({ type: "error", message: String(message) }) + "\n");
const DONE = () => encoder.encode(JSON.stringify({ type: "done" }) + "\n");

function toBytesFromBase64(input: string) {
  const cleaned = input.includes(",") ? input.split(",").pop() ?? input : input;
  return Uint8Array.from(atob(cleaned), (c) => c.charCodeAt(0));
}

async function embed(text: string) {
  const res = await fetch("https://api.openai.com/v1/embeddings", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${openaiKey}`
    },
    body: JSON.stringify({ model: "text-embedding-3-small", input: text })
  });
  if (!res.ok) throw new Error("Embedding failed");
  const json = await res.json();
  return json.data[0].embedding as number[];
}

async function vectorLookup(companyId: string | undefined, query: string) {
  if (!companyId) return [];
  const { data, error } = await supabase.rpc("match_documents", {
    query_embedding: await embed(query),
    company_id: companyId,
    match_count: 4
  });
  if (error) {
    console.warn("vector lookup error", error.message);
    return [];
  }
  return data ?? [];
}

async function transcribeChunk(base64: string) {
  // NOTE: This uses non-streaming Whisper; for production, swap to streaming ASR if available.
  const audioBytes = toBytesFromBase64(base64);
  const formData = new FormData();
  formData.append("file", new Blob([audioBytes], { type: "audio/webm" }), "audio.webm");
  formData.append("model", "whisper-1");
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
  return data.text as string;
}

async function fetchPersona(personaId: string) {
  const { data, error } = await supabase.from("personas").select().eq("id", personaId).single();
  if (error || !data) throw new Error(`Persona not found: ${personaId}`);
  return data;
}

async function streamGemini(
  messages: { role: "system" | "user"; content: string }[],
  controller: ReadableStreamDefaultController
) {
  const res = await fetch("https://openrouter.ai/api/v1/chat/completions", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${openrouterKey}`
    },
    body: JSON.stringify({
      model: "google/gemini-3-pro-preview",
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
      if (payload === "[DONE]") {
        controller.enqueue(DONE());
        return;
      }
      try {
        const parsed = JSON.parse(payload);
        const text = parsed.choices?.[0]?.delta?.content ?? "";
        if (text) {
          controller.enqueue(
            encoder.encode(JSON.stringify({ type: "text", role: "ai", text }) + "\n")
          );
        }
      } catch {
        // ignore malformed chunks
      }
    }
  }
}

async function synthesizeTts(text: string) {
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
  const base64 = btoa(String.fromCharCode(...new Uint8Array(arrayBuffer)));
  return { base64, mime: "audio/mpeg" };
}

function wsUpgrade(req: Request): Response | undefined {
  const upgrade = req.headers.get("upgrade") || "";
  if (upgrade.toLowerCase() != "websocket") return;
  const { socket, response } = Deno.upgradeWebSocket(req);
  handleSocket(socket);
  return response;
}

function handleSocket(socket: WebSocket) {
  let personaId: string | undefined;
  let conversationId: string | undefined;
  let companyId: string | undefined;
  let transcriptBuffer = "";
  let persona: any | undefined;

  socket.addEventListener("message", async (event) => {
    try {
      const msg = JSON.parse(event.data) as WSMessage;
      if (msg.type === "ping") {
        socket.send(JSON.stringify({ type: "pong" }));
        return;
      }
      if (msg.type === "start") {
        personaId = msg.personaId;
        conversationId = msg.conversationId;
        companyId = msg.companyId;
        persona = await fetchPersona(personaId);
        socket.send(JSON.stringify({ type: "status", value: "ready" }));
        return;
      }
      if (msg.type === "audio") {
        if (!personaId) {
          socket.send(JSON.stringify({ type: "error", message: "start not sent" }));
          return;
        }
        if (!persona) {
          try {
            persona = await fetchPersona(personaId);
          } catch (err: any) {
            socket.send(ERROR(err?.message ?? String(err)));
            return;
          }
        }
        socket.send(JSON.stringify({ type: "status", value: "listening" }));
        const userText = await transcribeChunk(msg.base64);

        // RAG context
        const rag = await vectorLookup(companyId, userText);
        const ragContext =
          rag?.map((r: any) => r.content).join("\n---\n") ?? "No company-specific context.";

        const systemPrompt = [
          "You are role-playing a sales prospect for training. Stay strictly in character.",
          `Persona Card: ${persona.name} (${persona.role})`,
          `Persona Backstory: ${persona.prompt}`,
          "Rules:",
          "- Respond only in English, even if the user speaks another language.",
          "- Keep replies concise (1-3 sentences), conversational, and realistic.",
          "- Avoid sign-offs like “Thanks for watching” or social media requests.",
          "- If the user goes off-topic or asks for unrelated actions, steer back to the sales conversation.",
          "- If audio is unclear, briefly ask for clarification instead of inventing content."
        ].join("\n");

        const messages = [
          { role: "system", content: `${systemPrompt}\n\nContext (may be empty):\n${ragContext}` },
          { role: "user", content: userText }
        ];

        socket.send(JSON.stringify({ type: "status", value: "thinking" }));

        const stream = new ReadableStream({
          start: async (controller) => {
            try {
              await streamGemini(messages, controller);
            } catch (err: any) {
              controller.enqueue(ERROR(err?.message ?? String(err)));
            } finally {
              controller.close();
            }
          }
        });

        const reader = stream.getReader();
        while (true) {
          const { value, done } = await reader.read();
          if (done) break;
          if (!value) continue;
          socket.send(new TextDecoder().decode(value));
        }

        // synthesize last buffer if present
        if (transcriptBuffer.trim()) {
          try {
            const tts = await synthesizeTts(transcriptBuffer);
            socket.send(JSON.stringify({ type: "tts", ...tts }));
            transcriptBuffer = "";
          } catch (err: any) {
            socket.send(ERROR(err?.message ?? String(err)));
          }
        }
        socket.send(JSON.stringify({ type: "status", value: "speaking" }));
        return;
      }
      if (msg.type === "stop") {
        socket.send(DONE());
        socket.close(1000, "client stop");
        return;
      }
    } catch (err: any) {
      socket.send(JSON.stringify({ type: "error", message: err?.message ?? String(err) }));
    }
  });

  socket.addEventListener("close", () => {
    // cleanup if needed
  });
}

Deno.serve((req) => {
  const wsResponse = wsUpgrade(req);
  if (wsResponse) return wsResponse;
  return new Response("Upgrade Required", { status: 426 });
});

