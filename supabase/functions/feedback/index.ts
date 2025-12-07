// deno-lint-ignore-file no-explicit-any
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.46.0";

const supabaseUrl = Deno.env.get("SUPABASE_URL")!;
const supabaseKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const claudeKey = Deno.env.get("CLAUDE_API_KEY")!;
const supabase = createClient(supabaseUrl, supabaseKey);

type Body = { conversationId: string; transcript: any[] };

async function scoreWithClaude(transcript: any[]) {
  const res = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-api-key": claudeKey,
      "anthropic-version": "2023-06-01"
    },
    body: JSON.stringify({
      model: "claude-sonnet-4-5",
      max_tokens: 600,
      system:
        "You are a sales coach. Score 1-10, list strengths, weaknesses, and suggested phrasing improvements. Return JSON keys: score, strengths, weaknesses, suggestions.",
      messages: [
        {
          role: "user",
          content: transcript
            .map((m) => `${m.role.toUpperCase()}: ${m.text}`)
            .join("\n")
        }
      ]
    })
  });

  if (!res.ok) throw new Error("Claude call failed");
  const data = await res.json();
  const jsonBlock = data?.content?.[0]?.text ?? "{}";
  try {
    return JSON.parse(jsonBlock);
  } catch {
    return { score: 0, strengths: [], weaknesses: [], suggestions: [] };
  }
}

Deno.serve(async (req) => {
  if (req.method !== "POST") return new Response("Method not allowed", { status: 405 });

  const body = (await req.json()) as Body;
  if (!body.conversationId || !body.transcript) {
    return new Response(JSON.stringify({ error: "Missing payload" }), {
      status: 400,
      headers: { "Content-Type": "application/json" }
    });
  }

  try {
    const feedback = await scoreWithClaude(body.transcript);
    await supabase
      .from("conversations")
      .update({ feedback_json: feedback })
      .eq("id", body.conversationId);

    return new Response(JSON.stringify(feedback), {
      headers: { "Content-Type": "application/json" }
    });
  } catch (err: any) {
    return new Response(JSON.stringify({ error: err.message ?? String(err) }), {
      status: 500,
      headers: { "Content-Type": "application/json" }
    });
  }
});

