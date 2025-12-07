import Constants from "expo-constants";

type Handlers = {
  onText: (text: string) => void;
  onTts: (payload: { base64: string; mime: string }) => void;
  onStatus?: (value: string) => void;
  onError?: (message: string) => void;
};

type StartPayload = {
  personaId: string;
  conversationId?: string;
  companyId?: string;
};

export class VoiceWsClient {
  private socket: WebSocket | null = null;
  private url: string;
  private handlers: Handlers;

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
      } catch {
        // ignore malformed
      }
    };
    this.socket.onerror = () => {
      this.handlers.onError?.("WebSocket error");
    };
    this.socket.onclose = () => {
      this.socket = null;
    };
  }

  sendAudio(id: string, mime: string, base64: string) {
    this.send({ type: "audio", id, mime, base64 });
  }

  stop() {
    this.send({ type: "stop" });
    this.socket?.close();
    this.socket = null;
  }

  private send(payload: any) {
    if (!this.socket || this.socket.readyState !== WebSocket.OPEN) return;
    this.socket.send(JSON.stringify(payload));
  }
}

