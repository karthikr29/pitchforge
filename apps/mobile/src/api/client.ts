import Constants from "expo-constants";
import { StreamChunk, Message, Feedback } from "../types";

const BASE_URL = (Constants.expoConfig?.extra as any)?.apiBaseUrl || "";
const OPENAI_KEY = (Constants.expoConfig?.extra as any)?.openaiKey || "";
const CLAUDE_KEY = (Constants.expoConfig?.extra as any)?.claudeKey || "";

type StreamHandlers = {
  onText: (chunk: StreamChunk & { type: "text" }) => void;
  onDone?: () => void;
  onError?: (message: string) => void;
  signal?: AbortSignal;
};

export async function streamVoiceSession(
  payload: {
    audioBase64: string;
    personaId: string;
    companyId?: string;
    conversationId?: string;
  },
  handlers: StreamHandlers
) {
  const res = await fetch(`${BASE_URL}/voice-session`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json"
    },
    body: JSON.stringify(payload),
    signal: handlers.signal
  });

  if (!res.ok || !res.body) {
    handlers.onError?.(`Failed to start stream (${res.status})`);
    return;
  }

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
      if (!line.trim()) continue;
      try {
        const chunk = JSON.parse(line) as StreamChunk;
        if (chunk.type === "text") {
          handlers.onText({ ...chunk, type: "text" });
        } else if (chunk.type === "error") {
          handlers.onError?.(chunk.message);
        } else if (chunk.type === "done") {
          handlers.onDone?.();
        }
      } catch (err) {
        handlers.onError?.(`Malformed chunk: ${err}`);
      }
    }
  }

  handlers.onDone?.();
}

export async function fetchMinutes(companyId?: string) {
  const res = await fetch(`${BASE_URL}/minutes?companyId=${companyId ?? ""}`);
  if (!res.ok) throw new Error("Failed to fetch minutes");
  const data = await res.json();
  return data.remainingMinutes as number;
}

export async function submitFeedback(conversationId: string, transcript: Message[]): Promise<Feedback> {
  const res = await fetch(`${BASE_URL}/feedback`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ conversationId, transcript })
  });
  if (!res.ok) throw new Error(`Feedback failed (${res.status})`);
  return (await res.json()) as Feedback;
}

export async function synthesizeTts(text: string, voice = "alloy") {
  if (!OPENAI_KEY) throw new Error("OPENAI_API_KEY missing");

  const res = await fetch("https://api.openai.com/v1/audio/speech", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${OPENAI_KEY}`
    },
    body: JSON.stringify({
      model: "tts-1",
      voice,
      input: text
    })
  });

  if (!res.ok) {
    const message = await res.text();
    throw new Error(`TTS failed: ${message}`);
  }

  const arrayBuffer = await res.arrayBuffer();
  return arrayBuffer;
}

export async function requestFeedbackLLM(transcript: Message[]) {
  if (!CLAUDE_KEY) throw new Error("CLAUDE_API_KEY missing");
  const res = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-api-key": CLAUDE_KEY,
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

  if (!res.ok) throw new Error("Claude request failed");
  const data = await res.json();
  return data;
}

