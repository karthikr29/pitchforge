// deno-lint-ignore-file no-explicit-any
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.46.0";

const supabaseUrl = Deno.env.get("SUPABASE_URL")!;
const supabaseKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const openaiKey = Deno.env.get("OPENAI_API_KEY")!;
const openrouterKey = Deno.env.get("OPENROUTER_API_KEY")!;

const supabase = createClient(supabaseUrl, supabaseKey);

type Body = {
  audioBase64: string;
  personaId: string;
  companyId?: string;
  conversationId?: string;
};

function toBytesFromBase64(input: string) {
  const cleaned = input.includes(",") ? input.split(",").pop() ?? input : input;
  try {
    return Uint8Array.from(atob(cleaned), (c) => c.charCodeAt(0));
  } catch (err) {
    throw new Error("Invalid audio payload (base64 decode failed)");
  }
}

async function transcribeWhisper(base64: string) {
  const audioBytes = toBytesFromBase64(base64);
  const formData = new FormData();
  formData.append("file", new Blob([audioBytes], { type: "audio/mpeg" }), "audio.mp3");
  formData.append("model", "whisper-1");

  const res = await fetch("https://api.openai.com/v1/audio/transcriptions", {
    method: "POST",
    headers: { Authorization: `Bearer ${openaiKey}` },
    body: formData
  });

  if (!res.ok) throw new Error(`Whisper failed (${res.status})`);
  const data = await res.json();
  return data.text as string;
}

async function fetchPersonaPrompt(personaId: string) {
  const { data, error } = await supabase.from("personas").select().eq("id", personaId).single();
  if (error || !data) throw new Error(`Persona not found: ${personaId}`);
  return data;
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

async function streamGemini(prompt: string, controller: ReadableStreamDefaultController) {
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
      if (payload === "[DONE]") {
        controller.enqueue(encoder.encode(JSON.stringify({ type: "done" }) + "\n"));
        return;
      }
      try {
        const parsed = JSON.parse(payload);
        const text = parsed.choices?.[0]?.delta?.content ?? "";
        if (text) {
          controller.enqueue(encoder.encode(JSON.stringify({ type: "text", text, turnId: crypto.randomUUID() }) + "\n"));
        }
      } catch {
        // ignore malformed chunks
      }
    }
  }
}

const encoder = new TextEncoder();

Deno.serve(async (req) => {
  if (req.method !== "POST") {
    return new Response("Method not allowed", { status: 405 });
  }

  const body = (await req.json()) as Body;
  if (!body.audioBase64 || !body.personaId) {
    return new Response(JSON.stringify({ error: "Missing payload" }), {
      status: 400,
      headers: { "Content-Type": "application/json" }
    });
  }

  const companyId = body.companyId;

  // Minutes check
  if (companyId) {
    const { data: company } = await supabase
      .from("companies")
      .select("minutes_balance")
      .eq("id", companyId)
      .single();
    if (company && company.minutes_balance <= 0) {
      return new Response(JSON.stringify({ error: "Minutes exhausted" }), {
        status: 402,
        headers: { "Content-Type": "application/json" }
      });
    }
  }

  const stream = new ReadableStream({
    start: async (controller) => {
      try {
        const persona = await fetchPersonaPrompt(body.personaId);
        const transcript = await transcribeWhisper(body.audioBase64);

        const rag = await vectorLookup(companyId, transcript);
        const ragContext =
          rag?.map((r: any) => r.content).join("\n---\n") ??
          "No company-specific context.";

        const prompt = [
          `Persona: ${persona.name} (${persona.role})`,
          persona.prompt,
          "Use the following context if relevant:",
          ragContext,
          `User said: ${transcript}`
        ].join("\n\n");

        await streamGemini(prompt, controller);

        // persist message
        await supabase.from("conversation_messages").insert({
          conversation_id: body.conversationId,
          role: "user",
          content: transcript
        });
      } catch (err: any) {
        controller.enqueue(
          encoder.encode(JSON.stringify({ type: "error", message: err.message ?? String(err) }) + "\n")
        );
      } finally {
        controller.close();
      }
    }
  });

  return new Response(stream, {
    headers: {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache"
    }
  });
});

