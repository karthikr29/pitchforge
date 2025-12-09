import Constants from "expo-constants";

type Handlers = {
  onText: (text: string) => void;
  onTts: (payload: { base64: string; mime: string }) => void;
  onStatus?: (value: string) => void;
  onError?: (message: string) => void;
  onTranscript?: (text: string) => void;
};

type StartPayload = {
  personaId: string;
  conversationId?: string;
  companyId?: string;
};

// Audio stream configuration for real-time streaming
export type AudioStreamConfig = {
  sampleRate: number;  // e.g., 16000
  channels: number;    // e.g., 1 (mono)
  encoding: string;    // e.g., 'pcm_16bit'
};

export class VoiceWsClient {
  private socket: WebSocket | null = null;
  private url: string;
  private handlers: Handlers;
  private streamConfig: AudioStreamConfig | null = null;

  constructor(handlers: Handlers) {
    const extra = (Constants.expoConfig?.extra as any) || {};
    const base = extra.wsBaseUrl || extra.apiBaseUrl || "";
    // Convert http/https to the correct ws/wss scheme; the previous string replace
    // would convert https -> ws (dropping TLS) which causes handshake failures on iOS.
    const url = new URL(base);
    url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
    this.url = `${url.toString().replace(/\/$/, "")}/voice-session-ws`;
    this.handlers = handlers;
  }

  connect(start: StartPayload) {
    this.socket = new WebSocket(this.url);
    this.socket.onopen = () => {
      this.send({ type: "start", ...start });
    };
    this.socket.onmessage = (event) => {
      try {
        const msg = JSON.parse(event.data);
        if (msg.type === "text" && msg.text) this.handlers.onText(msg.text);
        else if (msg.type === "tts" && msg.base64) this.handlers.onTts({ base64: msg.base64, mime: msg.mime ?? "audio/mpeg" });
        else if (msg.type === "status" && msg.value) this.handlers.onStatus?.(msg.value);
        else if (msg.type === "error" && msg.message) this.handlers.onError?.(msg.message);
        else if (msg.type === "transcript" && msg.text) this.handlers.onTranscript?.(msg.text);
      } catch {
        // ignore malformed
      }
    };
    this.socket.onerror = () => {
      this.handlers.onError?.("WebSocket error");
    };
    this.socket.onclose = () => {
      this.socket = null;
      this.streamConfig = null;
    };
  }

  // Start audio streaming mode with given config
  startAudioStream(config: AudioStreamConfig) {
    this.streamConfig = config;
    this.send({
      type: "audio-stream-start",
      sampleRate: config.sampleRate,
      channels: config.channels,
      encoding: config.encoding
    });
  }

  // Send a raw audio chunk (base64 encoded PCM data)
  sendAudioChunk(base64: string) {
    if (!this.streamConfig) {
      console.warn("[VoiceWsClient] Audio stream not started; call startAudioStream first");
      return;
    }
    this.send({ type: "audio-chunk", base64 });
  }

  // Signal end of audio stream (triggers transcription/response)
  endAudioStream() {
    this.send({ type: "audio-stream-end" });
    this.streamConfig = null;
  }

  // Legacy: send a full audio file (for backwards compatibility)
  sendAudio(id: string, mime: string, base64: string) {
    this.send({ type: "audio", id, mime, base64 });
  }

  stop() {
    this.send({ type: "stop" });
    this.socket?.close();
    this.socket = null;
    this.streamConfig = null;
  }

  isConnected(): boolean {
    return this.socket !== null && this.socket.readyState === WebSocket.OPEN;
  }

  private send(payload: any) {
    if (!this.socket || this.socket.readyState !== WebSocket.OPEN) return;
    this.socket.send(JSON.stringify(payload));
  }
}

