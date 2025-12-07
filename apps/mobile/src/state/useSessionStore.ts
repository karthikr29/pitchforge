import { create } from "zustand";
import { persist } from "zustand/middleware";
import { AudioItem, Feedback, Message } from "../types";

type StoreState = {
  personaId: string | null;
  conversationId: string | null;
  messages: Message[];
  streamingText: string;
  queue: AudioItem[];
  remainingMinutes: number | null;
  isRecording: boolean;
  isPlaying: boolean;
  feedback: Feedback | null;
  favorites: string[];
};

type StoreActions = {
  setPersona: (id: string) => void;
  startConversation: (conversationId: string) => void;
  addMessage: (message: Message) => void;
  setStreamingText: (text: string) => void;
  appendStreamingText: (text: string) => void;
  clearStreamingText: () => void;
  setQueue: (queue: AudioItem[]) => void;
  setRemainingMinutes: (value: number | null) => void;
  setRecording: (flag: boolean) => void;
  setPlaying: (flag: boolean) => void;
  setFeedback: (feedback: Feedback | null) => void;
  resetSession: () => void;
  toggleFavorite: (id: string) => void;
};

export const useSessionStore = create<StoreState & StoreActions>()(
  persist(
    (set, get) => ({
      personaId: null,
      conversationId: null,
      messages: [],
      streamingText: "",
      queue: [],
      remainingMinutes: null,
      isRecording: false,
      isPlaying: false,
      feedback: null,
      favorites: [],

      setPersona: (id) => set({ personaId: id }),
      startConversation: (conversationId) => set({ conversationId, messages: [], feedback: null }),
      addMessage: (message) => set({ messages: [...get().messages, message] }),
      setStreamingText: (text) => set({ streamingText: text }),
      appendStreamingText: (text) => set({ streamingText: get().streamingText + text }),
      clearStreamingText: () => set({ streamingText: "" }),
      setQueue: (queue) => set({ queue }),
      setRemainingMinutes: (value) => set({ remainingMinutes: value }),
      setRecording: (flag) => set({ isRecording: flag }),
      setPlaying: (flag) => set({ isPlaying: flag }),
      setFeedback: (feedback) => set({ feedback }),
      toggleFavorite: (id) =>
        set((state) => {
          const exists = state.favorites.includes(id);
          const next = exists ? state.favorites.filter((f) => f !== id) : [...state.favorites, id];
          return { favorites: next };
        }),
      resetSession: () =>
        set({
          conversationId: null,
          messages: [],
          streamingText: "",
          queue: [],
          isRecording: false,
          isPlaying: false,
          feedback: null,
          favorites: get().favorites
        })
    }),
    {
      name: "sales-training-store",
      partialize: (state) => ({
        messages: state.messages,
        remainingMinutes: state.remainingMinutes,
        personaId: state.personaId,
        favorites: state.favorites
      })
    }
  )
);

