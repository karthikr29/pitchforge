// deno-lint-ignore-file no-explicit-any
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.46.0";

const supabaseUrl = Deno.env.get("SUPABASE_URL")!;
const supabaseKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const supabase = createClient(supabaseUrl, supabaseKey);

type Body = {
  companyId: string;
  conversationId?: string;
  secondsUsed: number;
};

Deno.serve(async (req) => {
  if (req.method === "GET") {
    const url = new URL(req.url);
    const companyId = url.searchParams.get("companyId");
    if (!companyId) return new Response("companyId required", { status: 400 });
    const { data, error } = await supabase
      .from("companies")
      .select("minutes_balance")
      .eq("id", companyId)
      .single();
    if (error) return new Response(error.message, { status: 500 });
    return new Response(JSON.stringify({ remainingMinutes: data?.minutes_balance ?? 0 }), {
      headers: { "Content-Type": "application/json" }
    });
  }

  if (req.method !== "POST") return new Response("Method not allowed", { status: 405 });

  const body = (await req.json()) as Body;
  if (!body.companyId || !body.secondsUsed) {
    return new Response(JSON.stringify({ error: "Missing payload" }), {
      status: 400,
      headers: { "Content-Type": "application/json" }
    });
  }

  const seconds = Math.max(0, Math.round(body.secondsUsed));
  const minutes = Math.ceil(seconds / 60);

  const { data, error } = await supabase.rpc("decrement_minutes", {
    p_company_id: body.companyId,
    p_minutes: minutes
  });
  if (error) {
    return new Response(JSON.stringify({ error: error.message }), {
      status: 500,
      headers: { "Content-Type": "application/json" }
    });
  }

  if (body.conversationId) {
    await supabase
      .from("usage_ledger")
      .insert({
        company_id: body.companyId,
        conversation_id: body.conversationId,
        seconds_used: seconds
      })
      .select();
  }

  return new Response(JSON.stringify({ remainingMinutes: data?.minutes_balance ?? null }), {
    headers: { "Content-Type": "application/json" }
  });
});

