import Constants from "expo-constants";
import { Message } from "../types";

const supabaseUrl = (Constants.expoConfig?.extra as any)?.supabaseUrl || "";
const supabaseAnonKey = (Constants.expoConfig?.extra as any)?.supabaseAnonKey || "";

export type TranscriptEntryRemote = {
  id: string;
  created_at: string;
  persona_id?: string;
  duration_sec?: number;
  company_id?: string;
  messages: Message[];
};

function authHeaders() {
  if (!supabaseUrl || !supabaseAnonKey) {
    throw new Error("Supabase env missing");
  }
  return {
    apikey: supabaseAnonKey,
    Authorization: `Bearer ${supabaseAnonKey}`
  };
}

export async function fetchTranscriptsRemote(limit = 50): Promise<TranscriptEntryRemote[]> {
  const headers = authHeaders();
  const res = await fetch(
    `${supabaseUrl}/rest/v1/transcripts?select=id,created_at,persona_id,duration_sec,company_id,messages&order=created_at.desc&limit=${limit}`,
    { headers }
  );
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`Transcripts fetch failed (${res.status}) ${text}`);
  }
  const data = (await res.json()) as TranscriptEntryRemote[];
  return data;
}

export async function fetchTranscriptRemote(id: string): Promise<TranscriptEntryRemote | null> {
  const headers = authHeaders();
  const res = await fetch(
    `${supabaseUrl}/rest/v1/transcripts?id=eq.${encodeURIComponent(
      id
    )}&select=id,created_at,persona_id,duration_sec,company_id,messages`,
    { headers }
  );
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`Transcript fetch failed (${res.status}) ${text}`);
  }
  const data = (await res.json()) as TranscriptEntryRemote[];
  return data?.[0] ?? null;
}

export async function deleteTranscriptRemote(id: string): Promise<void> {
  const headers = {
    ...authHeaders(),
    Prefer: "return=minimal"
  };
  const res = await fetch(
    `${supabaseUrl}/rest/v1/transcripts?id=eq.${encodeURIComponent(id)}`,
    {
      method: "DELETE",
      headers
    }
  );
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`Transcript delete failed (${res.status}) ${text}`);
  }
}

