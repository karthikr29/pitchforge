export type Persona = {
  id: string;
  name: string;
  role: string;
  difficulty: "easy" | "medium" | "hard";
  prompt: string;
  voice: string;
  avatar?: string;
};

export type Message = {
  id: string;
  role: "user" | "ai" | "system";
  text: string;
  createdAt: string;
};

export type Feedback = {
  score: number;
  strengths: string[];
  weaknesses: string[];
  suggestions: string[];
};

export type StreamChunk =
  | { type: "text"; text: string; turnId: string }
  | { type: "error"; message: string }
  | { type: "done" };

export type AudioItem = { id: string; uri: string; text?: string };

